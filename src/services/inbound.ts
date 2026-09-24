import { Prisma, type MessageStatus } from "@prisma/client";
import type { Deps } from "../deps.js";
import { parseWebhook, messageAsConversationText, type InboundMessageEvent, type StatusEvent, type WebhookEvent } from "../whatsapp/webhook.js";
import { parseEvolutionWebhook } from "../whatsapp/evolution-webhook.js";
import { enqueueJob, REPLY_JOB, replyDedupeKey } from "../queue/jobs.js";
import { changeStatus, preview } from "./conversation.js";
import { log } from "../logger.js";

/**
 * Entrada do webhook: grava o corpo cru, registra cada mensagem UMA vez
 * (wamid único — a Meta reenvia o mesmo evento quando não recebe 200 a
 * tempo, e às vezes mesmo quando recebe) e põe a resposta na fila. Nada de
 * IA nem Italoc aqui: o webhook precisa responder rápido.
 */

/** Tipos que não pedem resposta (reação a uma mensagem nossa, por exemplo). */
const NO_REPLY_TYPES = new Set(["reaction"]);

const STATUS_RANK: Record<MessageStatus, number> = { RECEIVED: 0, PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

/** "PARAR", "SAIR"... — pedido explícito pra não receber mensagem ativa (follow-up). */
export function isOptOutMessage(text: string | null): boolean {
  if (!text) return false;
  return /^\s*(parar|sair|stop|cancelar mensagens|n[aã]o quero (mais )?receber( mensagens)?)\s*[.!]?\s*$/i.test(text);
}

export interface IngestOptions {
  provider: "META" | "EVOLUTION";
  /** Evolution: o canal já identificado pelo segredo da URL — evento de outro canal é descartado. */
  channelId?: string;
}

const PARSERS: Record<IngestOptions["provider"], (body: unknown) => WebhookEvent[]> = {
  META: parseWebhook,
  EVOLUTION: parseEvolutionWebhook,
};

export async function ingestWebhook(
  deps: Pick<Deps, "db">,
  body: unknown,
  opts: IngestOptions = { provider: "META" },
): Promise<{ messages: number; duplicates: number; statuses: number }> {
  const event = await deps.db.webhookEvent.create({ data: { payload: (body ?? {}) as Prisma.InputJsonValue } });
  const summary = { messages: 0, duplicates: 0, statuses: 0 };
  try {
    for (const item of PARSERS[opts.provider](body)) {
      if (item.kind === "status") {
        await applyStatus(deps, item);
        summary.statuses++;
      } else if (await ingestMessage(deps, item, opts)) summary.messages++;
      else summary.duplicates++;
    }
    await deps.db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date() } });
  } catch (error) {
    await deps.db.webhookEvent.update({ where: { id: event.id }, data: { error: error instanceof Error ? error.message.slice(0, 500) : "erro" } });
    throw error;
  }
  return summary;
}

async function applyStatus(deps: Pick<Deps, "db">, event: StatusEvent) {
  const message = await deps.db.message.findUnique({ where: { waMessageId: event.waMessageId }, select: { id: true, status: true } });
  if (!message) return;
  const next: MessageStatus = event.status === "sent" ? "SENT" : event.status === "delivered" ? "DELIVERED" : event.status === "read" ? "READ" : "FAILED";
  // Status chegam fora de ordem (lido antes de entregue) — só avança.
  if (next !== "FAILED" && STATUS_RANK[next] <= STATUS_RANK[message.status]) return;
  await deps.db.message.update({ where: { id: message.id }, data: { status: next, errorCode: event.errorCode } });
}

/** Devolve false quando a mensagem já tinha sido recebida (duplicada). */
async function ingestMessage(deps: Pick<Deps, "db">, event: InboundMessageEvent, opts: IngestOptions): Promise<boolean> {
  const channel = await deps.db.channel.findUnique({ where: { phoneNumberId: event.phoneNumberId } });
  if (!channel || !channel.active) {
    log.warn("mensagem para número não cadastrado/inativo ignorada", { phoneNumberId: event.phoneNumberId });
    return false;
  }
  // Evento de um provedor nunca alimenta canal de outro, e o webhook da
  // Evolution (autenticado pelo segredo de UM canal) só alimenta esse canal.
  if (channel.provider !== event.provider || (opts.channelId && channel.id !== opts.channelId)) {
    log.warn("evento para canal de outro provedor/segredo ignorado", { channelId: channel.id });
    return false;
  }
  if (event.fromMe) return ingestPhoneReply(deps, channel.id, event);

  const conversation = await deps.db.conversation.upsert({
    where: { channelId_waId: { channelId: channel.id, waId: event.waId } },
    create: { channelId: channel.id, companyId: channel.companyId, waId: event.waId, contactName: event.contactName },
    update: event.contactName ? { contactName: event.contactName } : {},
  });

  try {
    await deps.db.message.create({
      data: {
        conversationId: conversation.id,
        direction: "INBOUND",
        author: "CUSTOMER",
        waMessageId: event.waMessageId,
        type: event.type,
        text: event.text,
        mediaId: event.mediaId,
        mediaMime: event.mediaMime,
        payload: event.payload ? (event.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: "RECEIVED",
        // createdAt fica com a hora de RECEBIMENTO (padrão do banco), não o
        // timestamp da Meta: esse tem precisão de segundo e colocaria a
        // pergunta do cliente "antes" da nossa resposta do mesmo segundo,
        // bagunçando a ordem do histórico.
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      log.info("mensagem duplicada ignorada", { conversationId: conversation.id });
      return false;
    }
    throw error;
  }

  const now = new Date();
  const updated = await deps.db.conversation.update({
    where: { id: conversation.id },
    data: {
      lastInboundAt: now,
      lastMessageAt: now,
      lastMessagePreview: preview(messageAsConversationText(event)),
      unreadCount: { increment: 1 },
      // Conversa finalizada que recebe mensagem nova volta pro atendimento automático.
      ...(conversation.status === "CLOSED" ? { status: "BOT" as const } : {}),
      ...(isOptOutMessage(event.text) ? { optOut: true } : {}),
    },
  });
  if (conversation.status === "CLOSED") {
    await deps.db.handoff.create({ data: { conversationId: conversation.id, kind: "reopened", fromStatus: "CLOSED", toStatus: "BOT" } });
  }

  if (updated.status === "BOT" && channel.botEnabled && !NO_REPLY_TYPES.has(event.type)) {
    await enqueueJob(deps.db, { type: REPLY_JOB, conversationId: conversation.id, dedupeKey: replyDedupeKey(conversation.id) });
  }
  return true;
}

/**
 * Alguém da empresa respondeu pelo próprio celular (Evolution = WhatsApp Web,
 * o aparelho continua funcionando). Registra a fala como de atendente e tira
 * a conversa do bot, pra IA não responder por cima de um humano. Só vale pra
 * conversa que já existe — conversa pessoal iniciada pelo celular não vira
 * atendimento no painel.
 */
async function ingestPhoneReply(deps: Pick<Deps, "db">, channelId: string, event: InboundMessageEvent): Promise<boolean> {
  const conversation = await deps.db.conversation.findUnique({ where: { channelId_waId: { channelId, waId: event.waId } } });
  if (!conversation) return false;
  try {
    await deps.db.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        author: "AGENT",
        authorName: "Celular da empresa",
        waMessageId: event.waMessageId,
        type: event.type,
        text: event.text,
        mediaMime: event.mediaMime,
        payload: event.payload ? (event.payload as Prisma.InputJsonValue) : Prisma.JsonNull,
        status: "SENT",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
  await deps.db.message.updateMany({ where: { conversationId: conversation.id, direction: "INBOUND", handledAt: null }, data: { handledAt: new Date() } });
  await deps.db.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), lastMessagePreview: preview(event.text ?? `[${event.type}]`), unreadCount: 0 },
  });
  if (conversation.status === "BOT" || conversation.status === "AWAITING_AGENT") {
    await changeStatus(deps, conversation, "HUMAN", { kind: "phone_reply", reason: "Respondido pelo celular da empresa.", userName: "Celular da empresa" });
  }
  return true;
}
