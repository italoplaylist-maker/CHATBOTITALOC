import { log } from "../logger.js";

/**
 * Envio pela WhatsApp Cloud API (Graph API). O token vem do Channel já
 * descriptografado, só em memória, e nunca é logado.
 */
export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  /** Código de erro da Meta (ex: 131047 = fora da janela de 24h). */
  errorCode?: string;
  error?: string;
  /** Vale tentar de novo (rede, 5xx, limite) — erro de conteúdo/permissão não. */
  retryable?: boolean;
}

export interface TemplateMessage {
  name: string;
  language: string;
  bodyParams?: string[];
}

export interface WhatsAppSender {
  sendText(input: { phoneNumberId: string; accessToken: string; to: string; text: string }): Promise<SendResult>;
  sendTemplate(input: { phoneNumberId: string; accessToken: string; to: string; template: TemplateMessage }): Promise<SendResult>;
  markRead(input: { phoneNumberId: string; accessToken: string; waMessageId: string }): Promise<void>;
}

export function createWhatsAppSender(opts: { baseUrl: string; version: string; timeoutMs?: number }): WhatsAppSender {
  async function post(phoneNumberId: string, accessToken: string, body: unknown): Promise<SendResult> {
    const url = `${opts.baseUrl}/${opts.version}/${encodeURIComponent(phoneNumberId)}/messages`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
      const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { code?: number; message?: string } };
      if (res.ok && json.messages?.[0]?.id) return { ok: true, waMessageId: json.messages[0].id };
      const errorCode = json.error?.code != null ? String(json.error.code) : String(res.status);
      return { ok: false, errorCode, error: json.error?.message ?? `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 || errorCode === "130429" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "falha de rede", retryable: true };
    }
  }

  return {
    sendText: ({ phoneNumberId, accessToken, to, text }) =>
      post(phoneNumberId, accessToken, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } }),
    sendTemplate: ({ phoneNumberId, accessToken, to, template }) =>
      post(phoneNumberId, accessToken, {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: template.name,
          language: { code: template.language },
          components: template.bodyParams?.length
            ? [{ type: "body", parameters: template.bodyParams.map((text) => ({ type: "text", text })) }]
            : undefined,
        },
      }),
    async markRead({ phoneNumberId, accessToken, waMessageId }) {
      const result = await post(phoneNumberId, accessToken, { messaging_product: "whatsapp", status: "read", message_id: waMessageId });
      // "read" não devolve messages[].id — sucesso vem como { success: true }; só loga falha real.
      if (!result.ok && result.errorCode && result.errorCode !== "200") log.debug("markRead falhou", { errorCode: result.errorCode });
    },
  };
}

/** Janela de atendimento da Meta: texto livre só até 24h depois da última mensagem do cliente. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < CUSTOMER_SERVICE_WINDOW_MS;
}
