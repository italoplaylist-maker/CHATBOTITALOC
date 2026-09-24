import type { Channel, Conversation, ConversationStatus, MessageAuthor } from "@prisma/client";
import type { Deps } from "../deps.js";
import { decryptSecret } from "../lib/crypto.js";
import { enqueueJob, SEND_JOB } from "../queue/jobs.js";
import { isWithinServiceWindow, type TemplateMessage } from "../whatsapp/client.js";
import { log } from "../logger.js";

export class ConversationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function channelAccessToken(channel: Channel, key: string): string {
  return decryptSecret(channel.accessTokenEnc, key);
}

export function preview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Troca de estado da conversa, sempre registrada em Handoff (quem, quando, por quê). */
export async function changeStatus(
  deps: Pick<Deps, "db">,
  conversation: Conversation,
  to: ConversationStatus,
  info: { kind: string; reason?: string | null; userId?: string | null; userName?: string | null },
): Promise<Conversation> {
  return deps.db.$transaction(async (tx) => {
    const updated = await tx.conversation.update({
      where: { id: conversation.id },
      data: {
        status: to,
        handoffReason: to === "AWAITING_AGENT" ? (info.reason ?? null) : to === "BOT" ? null : conversation.handoffReason,
        assignedUserId: to === "HUMAN" ? (info.userId ?? null) : to === "BOT" || to === "CLOSED" ? null : conversation.assignedUserId,
        assignedUserName: to === "HUMAN" ? (info.userName ?? null) : to === "BOT" || to === "CLOSED" ? null : conversation.assignedUserName,
      },
    });
    await tx.handoff.create({
      data: {
        conversationId: conversation.id,
        kind: info.kind,
        reason: info.reason ?? null,
        fromStatus: conversation.status,
        toStatus: to,
        userId: info.userId ?? null,
        userName: info.userName ?? null,
      },
    });
    return updated;
  });
}

/**
 * Grava e envia uma mensagem nossa (bot ou atendente). Grava ANTES de
 * enviar: se o envio falhar, a mensagem fica registrada como FAILED (o
 * painel mostra) e, se o erro for temporário, vai pra fila de reenvio —
 * nunca se perde nem é gerada de novo pela IA.
 */
export async function sendOutboundText(
  deps: Pick<Deps, "db" | "whatsapp" | "config">,
  conversation: Conversation & { channel: Channel },
  input: { author: Exclude<MessageAuthor, "CUSTOMER">; text: string; authorName?: string | null },
) {
  const now = new Date();
  if (!isWithinServiceWindow(conversation.lastInboundAt, now)) {
    throw new ConversationError("outside_window", "Passaram mais de 24h desde a última mensagem do cliente — a Meta só permite enviar um modelo (template) aprovado.");
  }
  const message = await deps.db.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: input.author,
      authorName: input.authorName ?? null,
      type: "text",
      text: input.text,
      status: "PENDING",
    },
  });
  await deps.db.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: now, lastMessagePreview: preview(input.text) },
  });
  await deliverMessage(deps, message.id, conversation);
  return deps.db.message.findUniqueOrThrow({ where: { id: message.id } });
}

/** Envia uma mensagem já gravada (PENDING/FAILED sem wamid). Idempotente: mensagem já enviada não sai de novo. */
export async function deliverMessage(
  deps: Pick<Deps, "db" | "whatsapp" | "config">,
  messageId: string,
  conversation: Conversation & { channel: Channel },
): Promise<{ ok: boolean; retryable?: boolean }> {
  const message = await deps.db.message.findUniqueOrThrow({ where: { id: messageId } });
  if (message.waMessageId || (message.status !== "PENDING" && message.status !== "FAILED")) return { ok: true };

  const accessToken = channelAccessToken(conversation.channel, deps.config.CHANNEL_TOKEN_KEY);
  const payload = message.payload as { template?: TemplateMessage } | null;
  const result = payload?.template
    ? await deps.whatsapp.sendTemplate({ phoneNumberId: conversation.channel.phoneNumberId, accessToken, to: conversation.waId, template: payload.template })
    : await deps.whatsapp.sendText({ phoneNumberId: conversation.channel.phoneNumberId, accessToken, to: conversation.waId, text: message.text ?? "" });

  if (result.ok) {
    await deps.db.message.update({ where: { id: message.id }, data: { status: "SENT", waMessageId: result.waMessageId, errorCode: null } });
    return { ok: true };
  }
  await deps.db.message.update({ where: { id: message.id }, data: { status: "FAILED", errorCode: result.errorCode ?? null } });
  log.warn("envio WhatsApp falhou", { messageId: message.id, conversationId: conversation.id, errorCode: result.errorCode, retryable: result.retryable });
  if (result.retryable) {
    await enqueueJob(deps.db, {
      type: SEND_JOB,
      conversationId: conversation.id,
      dedupeKey: `send:${message.id}`,
      payload: { messageId: message.id },
      maxAttempts: 5,
      runAt: new Date(Date.now() + 5000),
    });
  }
  return { ok: false, retryable: result.retryable };
}

/** Fora da janela de 24h só sai modelo aprovado na Meta (uso do atendente). */
export async function sendOutboundTemplate(
  deps: Pick<Deps, "db" | "whatsapp" | "config">,
  conversation: Conversation & { channel: Channel },
  input: { template: TemplateMessage; authorName?: string | null },
) {
  const text = `[Modelo ${input.template.name}]${input.template.bodyParams?.length ? ` ${input.template.bodyParams.join(" | ")}` : ""}`;
  const message = await deps.db.message.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      author: "AGENT",
      authorName: input.authorName ?? null,
      type: "template",
      text,
      payload: { template: { ...input.template } },
      status: "PENDING",
    },
  });
  await deps.db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), lastMessagePreview: preview(text) } });
  await deliverMessage(deps, message.id, conversation);
  return deps.db.message.findUniqueOrThrow({ where: { id: message.id } });
}
