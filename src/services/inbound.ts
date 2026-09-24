import { Prisma, type MessageStatus } from "@prisma/client";
import type { Deps } from "../deps.js";
import { parseWebhook, messageAsConversationText, type InboundMessageEvent, type StatusEvent } from "../whatsapp/webhook.js";
import { enqueueJob, REPLY_JOB, replyDedupeKey } from "../queue/jobs.js";
import { preview } from "./conversation.js";
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

export async function ingestWebhook(deps: Pick<Deps, "db">, body: unknown): Promise<{ messages: number; duplicates: number; statuses: number }> {
  const event = await deps.db.webhookEvent.create({ data: { payload: (body ?? {}) as Prisma.InputJsonValue } });
  const summary = { messages: 0, duplicates: 0, statuses: 0 };
  try {
    for (const item of parseWebhook(body)) {
      if (item.kind === "status") {
        await applyStatus(deps, item);
        summary.statuses++;
      } else if (await ingestMessage(deps, item)) summary.messages++;
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
async function ingestMessage(deps: Pick<Deps, "db">, event: InboundMessageEvent): Promise<boolean> {
  const channel = await deps.db.channel.findUnique({ where: { phoneNumberId: event.phoneNumberId } });
  if (!channel || !channel.active) {
    log.warn("mensagem para número não cadastrado/inativo ignorada", { phoneNumberId: event.phoneNumberId });
    return false;
  }

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
