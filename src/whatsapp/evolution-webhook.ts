import { evolutionMessageId } from "./client.js";
import type { InboundMessageEvent, StatusEvent, WebhookEvent } from "./webhook.js";

/**
 * Leitura do webhook da Evolution API v2 (eventos MESSAGES_UPSERT e
 * MESSAGES_UPDATE). Função pura, mesmo formato de evento do webhook da Meta
 * — o resto do serviço não sabe de qual provedor a mensagem veio.
 *
 * Fica de fora: grupo, status (stories), canal, mensagem apagada/editada, e
 * mensagem que o PRÓPRIO número mandou por API (as nossas respostas e os
 * lembretes que o Italoc manda pela mesma instância). Mensagem que saiu do
 * número mas foi digitada no celular (source android/ios) entra como
 * resposta humana.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Aparelho de onde a mensagem saiu — a Evolution infere pelo formato do id. Celular = humano. */
const HUMAN_DEVICE_SOURCES = new Set(["android", "ios"]);

function phoneFromJid(jid: string | null): string | null {
  if (!jid || !jid.endsWith("@s.whatsapp.net")) return null;
  const digits = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  return digits.length >= 10 ? digits : null;
}

/** Desembrulha mensagem temporária / visualização única. */
function unwrap(message: Json | undefined): Json {
  let m = message ?? {};
  for (let i = 0; i < 3; i++) {
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

function describe(m: Json): Pick<InboundMessageEvent, "type" | "text" | "mediaId" | "mediaMime" | "payload"> | null {
  if (m.protocolMessage || (m.senderKeyDistributionMessage && Object.keys(m).length === 1)) return null;
  if (typeof m.conversation === "string") return { type: "text", text: m.conversation, mediaId: null, mediaMime: null, payload: null };
  if (m.extendedTextMessage) return { type: "text", text: str(m.extendedTextMessage.text), mediaId: null, mediaMime: null, payload: null };
  for (const [key, type] of [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["stickerMessage", "sticker"],
    ["documentMessage", "document"],
  ] as const) {
    const media = m[key];
    if (media) {
      return {
        type,
        text: str(media.caption),
        mediaId: null,
        mediaMime: str(media.mimetype),
        payload: media.fileName ? { filename: media.fileName } : null,
      };
    }
  }
  const loc = m.locationMessage ?? m.liveLocationMessage;
  if (loc) {
    const parts = [loc.name, loc.address].filter((x) => typeof x === "string" && x);
    return {
      type: "location",
      text: parts.length ? parts.join(" — ") : null,
      mediaId: null,
      mediaMime: null,
      payload: { latitude: loc.degreesLatitude, longitude: loc.degreesLongitude, name: loc.name ?? null, address: loc.address ?? null },
    };
  }
  const choice = str(m.buttonsResponseMessage?.selectedDisplayText) ?? str(m.templateButtonReplyMessage?.selectedDisplayText) ?? str(m.listResponseMessage?.title);
  if (choice) return { type: "interactive", text: choice, mediaId: null, mediaMime: null, payload: null };
  if (m.reactionMessage) return { type: "reaction", text: str(m.reactionMessage.text), mediaId: null, mediaMime: null, payload: null };
  return { type: "unsupported", text: null, mediaId: null, mediaMime: null, payload: { originalType: Object.keys(m)[0] ?? null } };
}

function parseMessage(instance: string, item: Json): InboundMessageEvent | null {
  const key = item?.key ?? {};
  const remoteJid = str(key.remoteJid);
  const keyId = str(key.id);
  if (!remoteJid || !keyId) return null;
  if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast") || remoteJid.endsWith("@newsletter")) return null;

  // Endereçamento novo do WhatsApp (@lid) esconde o telefone: a Evolution
  // manda o número de verdade em remoteJidAlt/senderPn. Sem ele, não dá pra
  // saber quem é o cliente — melhor ignorar do que atender o número errado.
  const waId = remoteJid.endsWith("@lid")
    ? phoneFromJid(str(key.remoteJidAlt) ?? str(key.senderPn) ?? str(item.senderPn))
    : phoneFromJid(remoteJid);
  if (!waId) return null;

  const fromMe = key.fromMe === true;
  if (fromMe && !HUMAN_DEVICE_SOURCES.has(String(item.source ?? "").toLowerCase())) return null;

  const content = describe(unwrap(item.message));
  if (!content) return null;

  const seconds = Number(item.messageTimestamp);
  return {
    kind: "message",
    provider: "EVOLUTION",
    fromMe,
    phoneNumberId: instance,
    waId,
    // Em mensagem que saiu do nosso número, pushName é o NOSSO nome.
    contactName: fromMe ? null : str(item.pushName),
    waMessageId: evolutionMessageId(instance, keyId),
    timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
    ...content,
  };
}

const STATUS_MAP: Record<string, StatusEvent["status"]> = {
  SERVER_ACK: "sent",
  DELIVERY_ACK: "delivered",
  READ: "read",
  PLAYED: "read",
  ERROR: "failed",
};

function parseStatus(instance: string, item: Json): StatusEvent | null {
  const keyId = str(item?.keyId) ?? str(item?.key?.id);
  const status = STATUS_MAP[String(item?.status ?? "").toUpperCase()];
  if (!keyId || !status) return null;
  return { kind: "status", provider: "EVOLUTION", phoneNumberId: instance, waMessageId: evolutionMessageId(instance, keyId), status, errorCode: null };
}

export function parseEvolutionWebhook(body: unknown): WebhookEvent[] {
  const root = (body ?? {}) as Json;
  const instance = str(root.instance);
  if (!instance) return [];
  // "messages.upsert" (padrão) ou "MESSAGES_UPSERT" (webhook por evento).
  const event = String(root.event ?? "").toLowerCase().replace(/_/g, ".");
  const items: Json[] = Array.isArray(root.data) ? root.data : root.data ? [root.data] : [];
  const out: WebhookEvent[] = [];
  for (const item of items) {
    const parsed = event === "messages.upsert" ? parseMessage(instance, item) : event === "messages.update" ? parseStatus(instance, item) : null;
    if (parsed) out.push(parsed);
  }
  return out;
}
