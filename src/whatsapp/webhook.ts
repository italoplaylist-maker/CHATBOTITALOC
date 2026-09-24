/**
 * Leitura do corpo do webhook da WhatsApp Cloud API (objeto
 * "whatsapp_business_account"). Função pura: transforma o JSON da Meta em
 * eventos simples — mensagem recebida ou mudança de status de mensagem
 * enviada. Tudo que não é reconhecido é ignorado, nunca derruba o webhook.
 */

export interface InboundMessageEvent {
  kind: "message";
  phoneNumberId: string;
  waId: string;
  contactName: string | null;
  waMessageId: string;
  timestamp: Date;
  type: string;
  /** Texto que representa a mensagem pra conversa (legenda, título do botão, descrição da localização...). */
  text: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  payload: Record<string, unknown> | null;
}

export interface StatusEvent {
  kind: "status";
  phoneNumberId: string;
  waMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode: string | null;
}

export type WebhookEvent = InboundMessageEvent | StatusEvent;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function describeMessage(m: Json): Pick<InboundMessageEvent, "type" | "text" | "mediaId" | "mediaMime" | "payload"> {
  const type = str(m.type) ?? "unsupported";
  switch (type) {
    case "text":
      return { type, text: str(m.text?.body), mediaId: null, mediaMime: null, payload: null };
    case "image":
    case "video":
    case "audio":
    case "sticker":
    case "document": {
      const media = m[type] ?? {};
      return {
        type,
        text: str(media.caption),
        mediaId: str(media.id),
        mediaMime: str(media.mime_type),
        payload: media.filename ? { filename: media.filename } : null,
      };
    }
    case "location": {
      const loc = m.location ?? {};
      const parts = [loc.name, loc.address].filter((x) => typeof x === "string" && x);
      return {
        type,
        text: parts.length ? parts.join(" — ") : null,
        mediaId: null,
        mediaMime: null,
        payload: { latitude: loc.latitude, longitude: loc.longitude, name: loc.name ?? null, address: loc.address ?? null },
      };
    }
    case "interactive": {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply ?? {};
      return { type, text: str(reply.title), mediaId: null, mediaMime: null, payload: { id: reply.id ?? null } };
    }
    case "button":
      return { type, text: str(m.button?.text), mediaId: null, mediaMime: null, payload: { payload: m.button?.payload ?? null } };
    case "reaction":
      return { type, text: str(m.reaction?.emoji), mediaId: null, mediaMime: null, payload: { messageId: m.reaction?.message_id ?? null } };
    default:
      return { type: "unsupported", text: null, mediaId: null, mediaMime: null, payload: { originalType: type } };
  }
}

export function parseWebhook(body: unknown): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const root = body as Json;
  if (!root || root.object !== "whatsapp_business_account" || !Array.isArray(root.entry)) return events;

  for (const entry of root.entry) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      const phoneNumberId = str(value.metadata?.phone_number_id);
      if (!phoneNumberId) continue;

      const contacts: Json[] = Array.isArray(value.contacts) ? value.contacts : [];
      for (const m of Array.isArray(value.messages) ? value.messages : []) {
        const waId = str(m?.from);
        const waMessageId = str(m?.id);
        if (!waId || !waMessageId) continue;
        const contact = contacts.find((c) => c?.wa_id === waId) ?? contacts[0];
        const seconds = Number(m.timestamp);
        events.push({
          kind: "message",
          phoneNumberId,
          waId,
          contactName: str(contact?.profile?.name),
          waMessageId,
          timestamp: Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(),
          ...describeMessage(m),
        });
      }

      for (const s of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = s?.status;
        const waMessageId = str(s?.id);
        if (!waMessageId || !["sent", "delivered", "read", "failed"].includes(status)) continue;
        const code = Array.isArray(s.errors) && s.errors[0]?.code != null ? String(s.errors[0].code) : null;
        events.push({ kind: "status", phoneNumberId, waMessageId, status, errorCode: code });
      }
    }
  }
  return events;
}

/** Texto que a IA/o painel vê pra uma mensagem que não é texto puro. */
export function messageAsConversationText(m: { type: string; text: string | null; payload?: unknown }): string {
  const payload = (m.payload ?? {}) as Json;
  switch (m.type) {
    case "text":
    case "interactive":
    case "button":
      return m.text ?? "";
    case "image":
      return `[O cliente enviou uma imagem${m.text ? ` com a legenda: "${m.text}"` : ""}]`;
    case "video":
      return `[O cliente enviou um vídeo${m.text ? ` com a legenda: "${m.text}"` : ""}]`;
    case "document":
      return `[O cliente enviou um documento${payload.filename ? ` (${payload.filename})` : ""}${m.text ? `: "${m.text}"` : ""}]`;
    case "audio":
      return "[O cliente enviou um áudio — não é possível ouvir áudios neste atendimento]";
    case "sticker":
      return "[O cliente enviou uma figurinha]";
    case "location":
      return `[O cliente enviou uma localização${m.text ? `: ${m.text}` : ""}]`;
    case "reaction":
      return `[O cliente reagiu com ${m.text ?? "um emoji"}]`;
    default:
      return "[O cliente enviou um tipo de mensagem não suportado]";
  }
}
