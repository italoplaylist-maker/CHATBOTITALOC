import { describe, it, expect } from "vitest";
import { parseWebhook, messageAsConversationText } from "../src/whatsapp/webhook.js";
import { signServiceRequest, verifyServiceSignature, verifyMetaSignature } from "../src/lib/signature.js";
import { encryptSecret, decryptSecret } from "../src/lib/crypto.js";
import { redact } from "../src/logger.js";
import { buildHistory } from "../src/ai/history.js";
import { isWithinServiceWindow } from "../src/whatsapp/client.js";
import { isOptOutMessage } from "../src/services/inbound.js";
import { retryDelayMs } from "../src/queue/jobs.js";
import { createHmac, randomBytes } from "node:crypto";
import { metaPayload } from "./helpers.js";

describe("parseWebhook", () => {
  it("lê mensagem de texto com nome do contato e número da empresa", () => {
    const [event] = parseWebhook(metaPayload([{ id: "wamid.1", text: "Quanto custa a betoneira?" }]));
    expect(event).toMatchObject({ kind: "message", phoneNumberId: "PNID-A", waId: "5511987654321", contactName: "Maria", waMessageId: "wamid.1", type: "text", text: "Quanto custa a betoneira?" });
  });

  it("imagem, áudio, localização, botão e tipo desconhecido", () => {
    const events = parseWebhook(
      metaPayload([
        { id: "w1", type: "image", extra: { image: { id: "MID", mime_type: "image/jpeg", caption: "obra" } } },
        { id: "w2", type: "audio", extra: { audio: { id: "AID", mime_type: "audio/ogg" } } },
        { id: "w3", type: "location", extra: { location: { latitude: -23.5, longitude: -46.6, name: "Obra", address: "Rua A, 10" } } },
        { id: "w4", type: "interactive", extra: { interactive: { type: "button_reply", button_reply: { id: "sim", title: "Sim, quero" } } } },
        { id: "w5", type: "ephemeral_new_type", extra: {} },
      ]),
    );
    expect(events.map((e) => (e.kind === "message" ? [e.type, e.text, e.mediaId] : null))).toEqual([
      ["image", "obra", "MID"],
      ["audio", null, "AID"],
      ["location", "Obra — Rua A, 10", null],
      ["interactive", "Sim, quero", null],
      ["unsupported", null, null],
    ]);
    expect(messageAsConversationText({ type: "audio", text: null })).toMatch(/áudio/);
  });

  it("lê status de entrega e ignora corpo que não é do WhatsApp", () => {
    const body = { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "P" }, statuses: [{ id: "wamid.x", status: "failed", errors: [{ code: 131047 }] }] } }] }] };
    expect(parseWebhook(body)).toEqual([{ kind: "status", phoneNumberId: "P", waMessageId: "wamid.x", status: "failed", errorCode: "131047" }]);
    expect(parseWebhook({ object: "page" })).toEqual([]);
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe("assinaturas", () => {
  it("mesmo vetor que o Italoc (lib/service-signature.ts) — contrato entre os serviços", () => {
    const parts = { timestamp: "1790000000", method: "POST", path: "/api/internal/chatbot/rentals", companyId: "empresa-a", body: '{"phone":"5511987654321"}' };
    const expected = `v1=${createHmac("sha256", "s3cr3t").update(["v1", ...Object.values(parts)].join("\n")).digest("hex")}`;
    expect(signServiceRequest("s3cr3t", parts)).toBe(expected);
    expect(verifyServiceSignature("s3cr3t", expected, parts, 1790000010)).toBe(true);
    expect(verifyServiceSignature("s3cr3t", expected, { ...parts, companyId: "empresa-b" }, 1790000010)).toBe(false);
    expect(verifyServiceSignature("s3cr3t", expected, parts, 1790000000 + 301)).toBe(false);
  });

  it("assinatura da Meta sobre o corpo cru", () => {
    const raw = '{"a":1}';
    const sig = `sha256=${createHmac("sha256", "app").update(raw).digest("hex")}`;
    expect(verifyMetaSignature("app", raw, sig)).toBe(true);
    expect(verifyMetaSignature("app", '{"a":2}', sig)).toBe(false);
    expect(verifyMetaSignature("app", raw, undefined)).toBe(false);
  });
});

describe("segredos", () => {
  it("token criptografado ida e volta; chave errada falha", () => {
    const key = randomBytes(32).toString("base64");
    const env = encryptSecret("EAAG-token", key);
    expect(env).not.toContain("EAAG");
    expect(decryptSecret(env, key)).toBe("EAAG-token");
    expect(() => decryptSecret(env, randomBytes(32).toString("base64"))).toThrow();
  });

  it("log mascara token/segredo/assinatura/copia e cola em qualquer nível", () => {
    expect(redact({ accessToken: "x", nested: { Authorization: "Bearer y", ok: 1, list: [{ api_key: "z" }] }, copiaECola: "000201" })).toEqual({
      accessToken: "[redacted]",
      nested: { Authorization: "[redacted]", ok: 1, list: [{ api_key: "[redacted]" }] },
      copiaECola: "[redacted]",
    });
  });
});

describe("histórico, janela e opt-out", () => {
  it("agrupa mensagens seguidas, marca atendente e começa pelo cliente", () => {
    const m = (direction: "INBOUND" | "OUTBOUND", author: "CUSTOMER" | "BOT" | "AGENT" | "SYSTEM", text: string, authorName: string | null = null) => ({ direction, author, authorName, type: "text", text, payload: null });
    const history = buildHistory([
      m("OUTBOUND", "BOT", "mensagem antiga do bot"),
      m("INBOUND", "CUSTOMER", "oi"),
      m("INBOUND", "CUSTOMER", "quanto custa a betoneira?"),
      m("OUTBOUND", "AGENT", "R$ 50 a diária", "João"),
      m("OUTBOUND", "SYSTEM", "interno"),
      m("INBOUND", "CUSTOMER", "e por 10 dias?"),
    ]);
    expect(history).toEqual([
      { role: "user", content: "oi\nquanto custa a betoneira?" },
      { role: "assistant", content: "[Atendente João]: R$ 50 a diária" },
      { role: "user", content: "e por 10 dias?" },
    ]);
  });

  it("janela de 24h da Meta", () => {
    const now = new Date("2026-10-01T12:00:00Z");
    expect(isWithinServiceWindow(new Date("2026-09-30T12:00:01Z"), now)).toBe(true);
    expect(isWithinServiceWindow(new Date("2026-09-30T11:59:59Z"), now)).toBe(false);
    expect(isWithinServiceWindow(null, now)).toBe(false);
  });

  it("opt-out só com pedido explícito", () => {
    expect(isOptOutMessage("PARAR")).toBe(true);
    expect(isOptOutMessage("não quero mais receber mensagens")).toBe(true);
    expect(isOptOutMessage("quero parar a locação")).toBe(false);
  });

  it("backoff da fila cresce", () => {
    expect([1, 2, 3].map(retryDelayMs)).toEqual([5000, 20000, 80000]);
  });
});
