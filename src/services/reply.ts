import { Prisma, type Job } from "@prisma/client";
import type { Deps } from "../deps.js";
import { runAgent, AiUnavailableError, type AgentResult } from "../ai/agent.js";
import { buildHistory } from "../ai/history.js";
import { FALLBACK_MESSAGE, HANDOFF_FALLBACK_MESSAGE, type ConversationContext } from "../ai/prompt.js";
import { changeStatus, channelAccessToken, deliverMessage, preview, sendOutboundText } from "./conversation.js";
import { log } from "../logger.js";

/**
 * Job "conversation.reply": responde TODAS as mensagens do cliente ainda não
 * respondidas, de uma vez (cliente que manda "oi", "tudo bem?", "quanto
 * custa a betoneira?" em sequência recebe uma resposta só).
 *
 * Só responde em BOT. Se durante o processamento um atendente assumir, a
 * resposta da IA é descartada — o humano manda.
 */
export async function processReplyJob(deps: Deps, job: Job): Promise<void> {
  if (!job.conversationId) return;
  const conversation = await deps.db.conversation.findUnique({ where: { id: job.conversationId }, include: { channel: true } });
  if (!conversation) return;
  if (conversation.status !== "BOT" || !conversation.channel.botEnabled || !conversation.channel.active) return;

  const pending = await deps.db.message.findMany({
    where: { conversationId: conversation.id, direction: "INBOUND", handledAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return;
  const trigger = pending[pending.length - 1];

  const recent = await deps.db.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    take: deps.config.AI_HISTORY_MESSAGES,
  });
  const history = buildHistory(recent.reverse());
  if (history.length === 0 || history[history.length - 1].role !== "user") {
    await markHandled(deps, pending.map((m) => m.id));
    return;
  }

  const context = await loadContext(deps, conversation.companyId, conversation.waId, conversation.contactName);
  const started = Date.now();
  let result: AgentResult;
  try {
    result = await runAgent(deps.ai, deps.italoc, {
      model: deps.config.AI_MODEL,
      effort: deps.config.AI_EFFORT,
      maxToolRounds: deps.config.AI_MAX_TOOL_ROUNDS,
      history,
      context,
      toolContext: {
        companyId: conversation.companyId,
        phone: conversation.waId,
        conversationId: conversation.id,
        contactName: conversation.contactName,
        triggerMessageId: trigger.waMessageId ?? trigger.id,
      },
    });
  } catch (error) {
    if (!(error instanceof AiUnavailableError)) throw error;
    log.error("IA indisponível — fallback com atendente", { conversationId: conversation.id, error: error.message });
    result = {
      reply: null,
      handoffReason: "Atendimento automático indisponível (falha na IA).",
      outcome: "fallback",
      stopReason: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      toolCalls: [],
      error: error.message,
    };
  }

  await deps.db.aiRun.create({
    data: {
      conversationId: conversation.id,
      model: deps.config.AI_MODEL,
      stopReason: result.stopReason,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      latencyMs: Date.now() - started,
      outcome: result.outcome,
      error: result.error?.slice(0, 500) ?? null,
      toolCalls: {
        create: result.toolCalls.map((t) => ({
          name: t.name,
          input: (t.input ?? {}) as Prisma.InputJsonValue,
          ok: t.ok,
          error: t.error,
          latencyMs: t.latencyMs,
        })),
      },
    },
  });

  // Um atendente pode ter assumido enquanto a IA pensava: aí a IA fica quieta.
  const fresh = await deps.db.conversation.findUniqueOrThrow({ where: { id: conversation.id }, include: { channel: true } });
  if (fresh.status !== "BOT") {
    log.info("resposta da IA descartada — conversa saiu do modo bot", { conversationId: fresh.id, status: fresh.status });
    return;
  }

  const text = result.reply ?? (result.outcome === "fallback" ? FALLBACK_MESSAGE : HANDOFF_FALLBACK_MESSAGE);
  // Resposta gravada e mensagens do cliente marcadas como respondidas na
  // MESMA transação: se o processo cair depois disso, o reenvio pega a
  // mensagem gravada (nunca chama a IA de novo pra mesma pergunta).
  const [reply] = await deps.db.$transaction([
    deps.db.message.create({
      data: { conversationId: fresh.id, direction: "OUTBOUND", author: "BOT", type: "text", text, status: "PENDING" },
    }),
    deps.db.message.updateMany({ where: { id: { in: pending.map((m) => m.id) }, handledAt: null }, data: { handledAt: new Date() } }),
    deps.db.conversation.update({ where: { id: fresh.id }, data: { lastMessageAt: new Date(), lastMessagePreview: preview(text) } }),
  ]);
  const delivery = await deliverMessage(deps, reply.id, fresh);
  if (!delivery.ok && !delivery.retryable) log.error("resposta do bot não pôde ser entregue", { conversationId: fresh.id, messageId: reply.id });

  // Marca a última mensagem do cliente como lida (os dois tiques azuis) — só cosmético, falha é ignorada.
  if (trigger.waMessageId) {
    deps.whatsapp
      .markRead({ phoneNumberId: fresh.channel.phoneNumberId, accessToken: channelAccessToken(fresh.channel, deps.config.CHANNEL_TOKEN_KEY), waMessageId: trigger.waMessageId })
      .catch(() => undefined);
  }

  if (result.handoffReason) {
    await changeStatus(deps, fresh, "AWAITING_AGENT", {
      kind: result.outcome === "fallback" ? "ai_failure" : "ai",
      reason: result.handoffReason,
    });
    const notified = await deps.italoc.call(fresh.companyId, "handoff", {
      phone: fresh.waId,
      contactName: fresh.contactName,
      reason: result.handoffReason,
      conversationId: fresh.id,
    });
    if (!notified.ok) log.warn("não foi possível avisar o Italoc da transferência", { conversationId: fresh.id, code: notified.code });
  }
}

async function markHandled(deps: Pick<Deps, "db">, ids: string[]) {
  await deps.db.message.updateMany({ where: { id: { in: ids }, handledAt: null }, data: { handledAt: new Date() } });
}

interface ItalocContext {
  customer: { name: string } | null;
  customerStatus: "found" | "not_found" | "ambiguous";
  companyName?: string | null;
  openOpportunity: { stageLabel: string | null; interest: string | null; quoteCode: string | null; awaitingConfirmation: boolean } | null;
  today: string;
}

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", weekday: "long" }).format(new Date());
}

/** Contexto do início da resposta. Se o Italoc não responder, segue sem ele (a IA sabe que não conseguiu verificar). */
async function loadContext(deps: Pick<Deps, "italoc">, companyId: string, phone: string, contactName: string | null): Promise<ConversationContext> {
  const result = await deps.italoc.call<ItalocContext>(companyId, "context", { phone });
  const today = todayInSaoPaulo();
  if (!result.ok) return { today, companyName: null, contactName, customerStatus: "unknown", customerName: null, openOpportunity: null };
  const d = result.data;
  const opp = d.openOpportunity;
  return {
    today,
    companyName: d.companyName ?? null,
    contactName,
    customerStatus: d.customerStatus,
    customerName: d.customer?.name ?? null,
    openOpportunity: opp
      ? [opp.stageLabel, opp.interest, opp.quoteCode, opp.awaitingConfirmation ? "cliente já aprovou, aguardando confirmação do atendente" : null].filter(Boolean).join(" · ")
      : null,
  };
}

/**
 * Última tentativa do job de resposta falhou por erro inesperado (banco,
 * bug): o cliente não pode ficar sem resposta — manda a mensagem fixa e
 * chama um atendente.
 */
export async function replyFallbackAfterFailure(deps: Deps, conversationId: string): Promise<void> {
  const conversation = await deps.db.conversation.findUnique({ where: { id: conversationId }, include: { channel: true } });
  if (!conversation || conversation.status !== "BOT") return;
  await markHandled(deps, (await deps.db.message.findMany({ where: { conversationId, direction: "INBOUND", handledAt: null }, select: { id: true } })).map((m) => m.id));
  await sendOutboundText(deps, conversation, { author: "BOT", text: FALLBACK_MESSAGE }).catch((e) =>
    log.error("fallback não pôde ser enviado", { conversationId, error: e instanceof Error ? e.message : String(e) }),
  );
  const updated = await changeStatus(deps, conversation, "AWAITING_AGENT", { kind: "ai_failure", reason: "Falha no atendimento automático." });
  await deps.italoc.call(updated.companyId, "handoff", { phone: updated.waId, contactName: updated.contactName, reason: "Falha no atendimento automático.", conversationId: updated.id });
}
