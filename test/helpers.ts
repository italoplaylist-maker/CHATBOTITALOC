import { createHmac, randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../src/db.js";
import type { Deps } from "../src/deps.js";
import type { AiClient } from "../src/ai/agent.js";
import type { ItalocApi, ItalocResult } from "../src/italoc/client.js";
import type { WhatsAppSender } from "../src/whatsapp/client.js";
import { encryptSecret } from "../src/lib/crypto.js";
import { createApp } from "../src/http/app.js";
import { claimNextJob } from "../src/queue/jobs.js";
import { runJob } from "../src/queue/worker.js";
import { COMPANY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signServiceRequest } from "../src/lib/signature.js";

export const TOKEN_KEY = randomBytes(32).toString("base64");
export const APP_SECRET = "meta-app-secret-de-teste";
export const VERIFY_TOKEN = "verify-token-de-teste-123";
export const SHARED_SECRET = "segredo-compartilhado-de-teste-com-32-chars";
export const COMPANY_A = "company-a";
export const COMPANY_B = "company-b";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "ToolCall","AiRun","Handoff","Message","Conversation","Channel","Job","WebhookEvent" RESTART IDENTITY CASCADE',
  );
}

export async function createChannel(opts: { companyId?: string; phoneNumberId?: string; botEnabled?: boolean } = {}) {
  return prisma.channel.create({
    data: {
      companyId: opts.companyId ?? COMPANY_A,
      name: "Empresa Teste",
      phoneNumberId: opts.phoneNumberId ?? "PNID-A",
      accessTokenEnc: encryptSecret("EAAG-token-de-teste", TOKEN_KEY),
      botEnabled: opts.botEnabled ?? true,
    },
  });
}

/** WhatsApp de mentira: grava o que seria enviado. */
export function fakeWhatsApp() {
  const sent: { to: string; text?: string; template?: string; phoneNumberId: string; accessToken: string }[] = [];
  let failNext: { errorCode: string; retryable: boolean } | null = null;
  let counter = 0;
  const sender: WhatsAppSender & { sent: typeof sent; failNext(e: { errorCode: string; retryable: boolean }): void } = {
    sent,
    failNext(e) {
      failNext = e;
    },
    async sendText(input) {
      if (failNext) {
        const f = failNext;
        failNext = null;
        return { ok: false, errorCode: f.errorCode, retryable: f.retryable, error: "falha simulada" };
      }
      sent.push({ to: input.to, text: input.text, phoneNumberId: input.phoneNumberId, accessToken: input.accessToken });
      return { ok: true, waMessageId: `wamid.out.${++counter}` };
    },
    async sendTemplate(input) {
      sent.push({ to: input.to, template: input.template.name, phoneNumberId: input.phoneNumberId, accessToken: input.accessToken });
      return { ok: true, waMessageId: `wamid.out.${++counter}` };
    },
    async markRead() {},
  };
  return sender;
}

/** Italoc de mentira: responde por ação e grava cada chamada (empresa + corpo). */
export function fakeItaloc(handlers: Record<string, (companyId: string, body: Record<string, unknown>) => ItalocResult | Promise<ItalocResult>> = {}) {
  const calls: { companyId: string; action: string; body: Record<string, unknown> }[] = [];
  const api: ItalocApi & { calls: typeof calls } = {
    calls,
    async call<T>(companyId: string, action: string, body: Record<string, unknown>) {
      calls.push({ companyId, action, body });
      const handler = handlers[action];
      if (handler) return (await handler(companyId, body)) as ItalocResult<T>;
      if (action === "context") return { ok: true, data: { customer: null, customerStatus: "not_found", openOpportunity: null, today: "01/10/2026" } as T };
      return { ok: true, data: { ok: true } as T };
    },
  };
  return api;
}

let seq = 0;
export function textResponse(text: string): BetaMessage {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

export function toolResponse(...calls: { name: string; input: Record<string, unknown> }[]): BetaMessage {
  return {
    id: `msg_${++seq}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: calls.map((c, i) => ({ type: "tool_use", id: `toolu_${seq}_${i}`, name: c.name, input: c.input })),
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

/** IA roteirizada: devolve as respostas na ordem e guarda cada request. */
export function scriptedAi(script: (BetaMessage | Error | ((params: CreateParams) => BetaMessage))[]) {
  const requests: CreateParams[] = [];
  const client: AiClient & { requests: CreateParams[] } = {
    requests,
    async createMessage(params) {
      requests.push(structuredClone(params));
      const next = script.shift();
      if (!next) throw new Error("roteiro da IA acabou");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(params) : next;
    },
  };
  return client;
}

export function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    db: prisma,
    config: { CHANNEL_TOKEN_KEY: TOKEN_KEY, AI_MODEL: "claude-opus-5", AI_EFFORT: "medium", AI_TIMEOUT_MS: 1000, AI_MAX_TOOL_ROUNDS: 6, AI_HISTORY_MESSAGES: 30 },
    whatsapp: fakeWhatsApp(),
    italoc: fakeItaloc(),
    ai: scriptedAi([]),
    ...overrides,
  };
}

export function makeApp(deps: Deps) {
  return createApp(deps, { config: { META_APP_SECRET: APP_SECRET, META_VERIFY_TOKEN: VERIFY_TOKEN, ITALOC_SHARED_SECRET: SHARED_SECRET } });
}

export function metaPayload(messages: { id: string; from?: string; text?: string; type?: string; extra?: Record<string, unknown> }[], phoneNumberId = "PNID-A") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "5511900000000", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Maria" }, wa_id: messages[0]?.from ?? "5511987654321" }],
              messages: messages.map((m) => ({
                from: m.from ?? "5511987654321",
                id: m.id,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: m.type ?? "text",
                ...(m.type && m.type !== "text" ? m.extra : { text: { body: m.text ?? "oi" } }),
              })),
            },
          },
        ],
      },
    ],
  };
}

export async function postWebhook(app: ReturnType<typeof makeApp>, body: unknown, secret = APP_SECRET) {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return app.request("/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": signature } });
}

/** Chamada assinada à API admin, como o Italoc faria. */
export async function adminRequest(app: ReturnType<typeof makeApp>, method: string, path: string, companyId: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signServiceRequest(SHARED_SECRET, { timestamp, method, path: `/admin${path}`, companyId, body: method === "GET" ? "" : raw });
  return app.request(`/admin${path}`, {
    method,
    body: method === "GET" ? undefined : raw,
    headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signature, [COMPANY_HEADER]: companyId },
  });
}

/** Roda a fila até esvaziar (sem worker em background). */
export async function drainQueue(deps: Deps, max = 20) {
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(deps.db);
    if (!job) return i;
    await runJob(deps, job);
  }
  return max;
}

export { prisma };
