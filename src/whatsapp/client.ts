import { log } from "../logger.js";

/**
 * Envio de mensagens pelos dois provedores:
 *
 * - META: WhatsApp Cloud API oficial (Graph API), token Bearer.
 * - EVOLUTION: Evolution API v2 (mesmo formato que o Italoc já usa em
 *   produção pros lembretes: POST /message/sendText/<instância> com
 *   { number, text } e cabeçalho apikey).
 *
 * A credencial vem do Channel já descriptografada, só em memória, e nunca
 * é logada.
 */
export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  /** Código de erro do provedor (ex: 131047 na Meta = fora da janela de 24h). */
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

export type ChannelProvider = "META" | "EVOLUTION";

export interface ChannelCredentials {
  provider: ChannelProvider;
  /** phone_number_id na Meta, nome da instância na Evolution. */
  externalId: string;
  /** URL do servidor da Evolution (null na Meta). */
  apiBaseUrl: string | null;
  accessToken: string;
}

export interface WhatsAppSender {
  sendText(input: { channel: ChannelCredentials; to: string; text: string }): Promise<SendResult>;
  sendTemplate(input: { channel: ChannelCredentials; to: string; template: TemplateMessage }): Promise<SendResult>;
  markRead(input: { channel: ChannelCredentials; to: string; waMessageId: string }): Promise<void>;
}

/**
 * Id de mensagem da Evolution guardado com o nome da instância na frente: o
 * id do WhatsApp Web não é garantidamente único entre números diferentes, e
 * Message.waMessageId é único no banco inteiro.
 */
export function evolutionMessageId(instance: string, keyId: string): string {
  return `evo:${instance}:${keyId}`;
}

function rawEvolutionId(waMessageId: string): string {
  return waMessageId.split(":").slice(2).join(":") || waMessageId;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ ok: boolean; status: number; json: Json } | { error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: res.ok, status: res.status, json: ((await res.json().catch(() => ({}))) ?? {}) as Json };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "falha de rede" };
  }
}

export function createWhatsAppSender(opts: { metaBaseUrl: string; metaVersion: string; timeoutMs?: number }): WhatsAppSender {
  const timeout = opts.timeoutMs ?? 15000;

  async function meta(channel: ChannelCredentials, body: unknown): Promise<SendResult> {
    const url = `${opts.metaBaseUrl}/${opts.metaVersion}/${encodeURIComponent(channel.externalId)}/messages`;
    const res = await postJson(url, { Authorization: `Bearer ${channel.accessToken}` }, body, timeout);
    if ("error" in res) return { ok: false, error: res.error, retryable: true };
    const id = res.json.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, waMessageId: id };
    const errorCode = res.json.error?.code != null ? String(res.json.error.code) : String(res.status);
    return {
      ok: false,
      errorCode,
      error: res.json.error?.message ?? `HTTP ${res.status}`,
      retryable: res.status >= 500 || res.status === 429 || errorCode === "130429",
    };
  }

  async function evolution(channel: ChannelCredentials, path: string, body: unknown): Promise<SendResult> {
    if (!channel.apiBaseUrl) return { ok: false, errorCode: "no_base_url", error: "Canal Evolution sem URL do servidor.", retryable: false };
    const url = `${channel.apiBaseUrl.replace(/\/+$/, "")}${path}/${encodeURIComponent(channel.externalId)}`;
    const res = await postJson(url, { apikey: channel.accessToken }, body, timeout);
    if ("error" in res) return { ok: false, error: res.error, retryable: true };
    const keyId = res.json.key?.id;
    if (res.ok && typeof keyId === "string") return { ok: true, waMessageId: evolutionMessageId(channel.externalId, keyId) };
    if (res.ok) return { ok: true };
    return {
      ok: false,
      errorCode: String(res.status),
      error: typeof res.json.message === "string" ? res.json.message : `Evolution respondeu ${res.status}`,
      // Instância desconectada (QR code caiu) responde 4xx: repetir na hora não adianta.
      retryable: res.status >= 500 || res.status === 429,
    };
  }

  return {
    async sendText({ channel, to, text }) {
      if (channel.provider === "EVOLUTION") return evolution(channel, "/message/sendText", { number: to, text });
      return meta(channel, { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } });
    },
    async sendTemplate({ channel, to, template }) {
      if (channel.provider === "EVOLUTION") {
        return { ok: false, errorCode: "template_unsupported", error: "Modelo (template) só existe na API oficial da Meta.", retryable: false };
      }
      return meta(channel, {
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
      });
    },
    async markRead({ channel, to, waMessageId }) {
      const result =
        channel.provider === "EVOLUTION"
          ? await evolution(channel, "/chat/markMessageAsRead", {
              readMessages: [{ remoteJid: `${to}@s.whatsapp.net`, fromMe: false, id: rawEvolutionId(waMessageId) }],
            })
          : await meta(channel, { messaging_product: "whatsapp", status: "read", message_id: waMessageId });
      // Só cosmético (tiques azuis): falha não interrompe nada.
      if (!result.ok && result.errorCode && result.errorCode !== "200") log.debug("markRead falhou", { errorCode: result.errorCode });
    },
  };
}

/** Janela de atendimento da Meta: texto livre só até 24h depois da última mensagem do cliente. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < CUSTOMER_SERVICE_WINDOW_MS;
}

/** Texto livre permitido agora? Na Evolution (WhatsApp Web) não existe a regra das 24h. */
export function canSendFreeText(provider: ChannelProvider, lastInboundAt: Date | null, now: Date = new Date()): boolean {
  return provider === "EVOLUTION" || isWithinServiceWindow(lastInboundAt, now);
}
