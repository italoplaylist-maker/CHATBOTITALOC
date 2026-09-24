import { beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  COMPANY_A,
  COMPANY_B,
  EVO_TOKEN,
  adminRequest,
  createChannel,
  createEvolutionChannel,
  drainQueue,
  evolutionPayload,
  fakeWhatsApp,
  makeApp,
  makeDeps,
  metaPayload,
  postEvolution,
  postWebhook,
  prisma,
  resetDb,
  scriptedAi,
  textResponse,
} from "./helpers.js";
import { parseEvolutionWebhook } from "../src/whatsapp/evolution-webhook.js";
import { createWhatsAppSender } from "../src/whatsapp/client.js";
import { createApp } from "../src/http/app.js";

const INSTANCE = "oscontrol-aaaa1111";
const PHONE = "5511987654321";

beforeEach(async () => {
  await resetDb();
});

describe("parseEvolutionWebhook", () => {
  it("texto simples, texto estendido, imagem com legenda e mensagem temporária", () => {
    const events = [
      evolutionPayload(INSTANCE, { id: "A1", text: "oi" }),
      evolutionPayload(INSTANCE, { id: "A2", message: { extendedTextMessage: { text: "link https://x" } } }),
      evolutionPayload(INSTANCE, { id: "A3", message: { imageMessage: { caption: "obra", mimetype: "image/jpeg" } } }),
      evolutionPayload(INSTANCE, { id: "A4", message: { ephemeralMessage: { message: { conversation: "sumindo" } } } }),
    ].flatMap(parseEvolutionWebhook);
    expect(events.map((e) => (e.kind === "message" ? [e.waMessageId, e.waId, e.type, e.text, e.contactName, e.provider] : null))).toEqual([
      [`evo:${INSTANCE}:A1`, PHONE, "text", "oi", "Maria", "EVOLUTION"],
      [`evo:${INSTANCE}:A2`, PHONE, "text", "link https://x", "Maria", "EVOLUTION"],
      [`evo:${INSTANCE}:A3`, PHONE, "image", "obra", "Maria", "EVOLUTION"],
      [`evo:${INSTANCE}:A4`, PHONE, "text", "sumindo", "Maria", "EVOLUTION"],
    ]);
  });

  it("ignora grupo, status, canal e mensagem apagada/editada", () => {
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "G", jid: "1203630@g.us" }))).toEqual([]);
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "S", jid: "status@broadcast" }))).toEqual([]);
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "N", jid: "123@newsletter" }))).toEqual([]);
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "P", message: { protocolMessage: { type: "REVOKE" } } }))).toEqual([]);
  });

  it("endereçamento @lid: usa o telefone de remoteJidAlt; sem telefone, ignora", () => {
    const [event] = parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "L1", jid: "99887766@lid", key: { remoteJidAlt: `${PHONE}@s.whatsapp.net` } }));
    expect(event).toMatchObject({ kind: "message", waId: PHONE });
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "L2", jid: "99887766@lid" }))).toEqual([]);
  });

  it("mensagem do próprio número: do celular (android/ios) entra como resposta humana; por API (nossa ou do Italoc) é ignorada", () => {
    const [phone] = parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "M1", fromMe: true, source: "android", text: "deixa comigo" }));
    expect(phone).toMatchObject({ kind: "message", fromMe: true, contactName: null, text: "deixa comigo" });
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "M2", fromMe: true, source: "web" }))).toEqual([]);
    expect(parseEvolutionWebhook(evolutionPayload(INSTANCE, { id: "M3", fromMe: true, source: "unknown" }))).toEqual([]);
  });

  it("status de entrega (messages.update) e corpo desconhecido", () => {
    const status = { event: "messages.update", instance: INSTANCE, data: { keyId: "OUT1", remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true, status: "READ" } };
    expect(parseEvolutionWebhook(status)).toEqual([
      { kind: "status", provider: "EVOLUTION", phoneNumberId: INSTANCE, waMessageId: `evo:${INSTANCE}:OUT1`, status: "read", errorCode: null },
    ]);
    expect(parseEvolutionWebhook({ event: "connection.update", instance: INSTANCE, data: { state: "open" } })).toEqual([]);
    expect(parseEvolutionWebhook(null)).toEqual([]);
  });
});

describe("webhook da Evolution", () => {
  it("segredo errado na URL → 404 e nada gravado", async () => {
    await createEvolutionChannel();
    const app = makeApp(makeDeps());
    const res = await postEvolution(app, evolutionPayload(INSTANCE, { id: "X1" }), "segredo-errado-segredo-errado-segredo-errado");
    expect(res.status).toBe(404);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("mensagem chega, IA responde pela Evolution pro número certo, duplicada é ignorada", async () => {
    await createEvolutionChannel();
    const whatsapp = fakeWhatsApp();
    const deps = makeDeps({ whatsapp, ai: scriptedAi([textResponse("Olá, Maria! Em que posso ajudar?")]) });
    const app = makeApp(deps);
    expect((await postEvolution(app, evolutionPayload(INSTANCE, { id: "E1", text: "oi" }))).status).toBe(200);
    expect((await postEvolution(app, evolutionPayload(INSTANCE, { id: "E1", text: "oi" }))).status).toBe(200);
    await drainQueue(deps);
    expect(await prisma.message.count({ where: { direction: "INBOUND" } })).toBe(1);
    expect(whatsapp.sent).toEqual([
      { to: PHONE, text: "Olá, Maria! Em que posso ajudar?", phoneNumberId: INSTANCE, accessToken: "evo-apikey-de-teste", provider: "EVOLUTION" },
    ]);
    expect(await prisma.conversation.findFirstOrThrow()).toMatchObject({ companyId: COMPANY_A, waId: PHONE, contactName: "Maria" });
  });

  it("segredo de um canal não alimenta outro canal; webhook da Meta não alimenta canal da Evolution", async () => {
    await createEvolutionChannel({ companyId: COMPANY_A, instance: "inst-a", token: EVO_TOKEN });
    await createEvolutionChannel({ companyId: COMPANY_B, instance: "inst-b", token: "outro-segredo-outro-segredo-outro-segredo" });
    const app = makeApp(makeDeps());
    // Segredo da empresa A com corpo dizendo ser da instância B.
    await postEvolution(app, evolutionPayload("inst-b", { id: "Z1" }), EVO_TOKEN);
    // Corpo da Meta (assinado) apontando pro nome da instância.
    await postWebhook(app, metaPayload([{ id: "wamid.z" }], "inst-a"));
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("resposta digitada no celular da empresa: vira fala do atendente e a IA para de responder", async () => {
    await createEvolutionChannel();
    const ai = scriptedAi([]);
    const deps = makeDeps({ ai });
    const app = makeApp(deps);
    await postEvolution(app, evolutionPayload(INSTANCE, { id: "C1", text: "tem betoneira?" }));
    await prisma.job.deleteMany();
    await postEvolution(app, evolutionPayload(INSTANCE, { id: "C2", fromMe: true, source: "ios", text: "Tem sim! Já te passo o valor." }));
    const conversation = await prisma.conversation.findFirstOrThrow();
    expect(conversation).toMatchObject({ status: "HUMAN", unreadCount: 0 });
    expect(await prisma.message.findFirst({ where: { direction: "OUTBOUND" } })).toMatchObject({ author: "AGENT", authorName: "Celular da empresa", text: "Tem sim! Já te passo o valor." });
    expect(await prisma.handoff.findFirst()).toMatchObject({ kind: "phone_reply", toStatus: "HUMAN" });
    await postEvolution(app, evolutionPayload(INSTANCE, { id: "C3", text: "quanto fica?" }));
    await drainQueue(deps);
    expect(ai.requests).toHaveLength(0);
  });

  it("mensagem do celular pra quem nunca falou com o atendimento não cria conversa (chat pessoal)", async () => {
    await createEvolutionChannel();
    const app = makeApp(makeDeps());
    await postEvolution(app, evolutionPayload(INSTANCE, { id: "P1", from: "5511911112222", fromMe: true, source: "android", text: "oi fornecedor" }));
    expect(await prisma.conversation.count()).toBe(0);
  });

  it("sem janela de 24h na Evolution; modelo (template) é recusado com mensagem clara", async () => {
    await createEvolutionChannel();
    const whatsapp = fakeWhatsApp();
    const deps = makeDeps({ whatsapp });
    const app = makeApp(deps);
    await postEvolution(app, evolutionPayload(INSTANCE, { id: "W1" }));
    await prisma.job.deleteMany();
    const conversation = await prisma.conversation.update({
      where: { id: (await prisma.conversation.findFirstOrThrow()).id },
      data: { lastInboundAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) },
    });
    const list = (await (await adminRequest(app, "GET", "/conversations", COMPANY_A)).json()) as { conversations: { withinServiceWindow: boolean; channel: { provider: string } }[] };
    expect(list.conversations[0]).toMatchObject({ withinServiceWindow: true, channel: { provider: "EVOLUTION" } });
    const text = await adminRequest(app, "POST", `/conversations/${conversation.id}/messages`, COMPANY_A, { userId: "u1", userName: "João", text: "Oi, tudo certo com a locação?" });
    expect(text.status).toBe(200);
    expect(whatsapp.sent.at(-1)).toMatchObject({ provider: "EVOLUTION", text: "Oi, tudo certo com a locação?" });
    const template = await adminRequest(app, "POST", `/conversations/${conversation.id}/template`, COMPANY_A, { userId: "u1", userName: "João", name: "retomar", language: "pt_BR" });
    expect(template.status).toBe(422);
  });

  it("sem META_APP_SECRET, o webhook da Meta fica desligado", async () => {
    const app = createApp(makeDeps(), { config: { META_APP_SECRET: undefined, META_VERIFY_TOKEN: undefined, ITALOC_SHARED_SECRET: "x".repeat(32) } });
    expect((await app.request("/webhooks/whatsapp", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1")).status).toBe(403);
  });
});

describe("envio real pela Evolution (formato do Italoc em produção)", () => {
  it("sendText e markRead chamam a instância com apikey e o corpo da v2", async () => {
    const calls: { url: string; apikey: string | undefined; body: unknown }[] = [];
    const server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        calls.push({ url: req.url ?? "", apikey: req.headers.apikey as string | undefined, body: JSON.parse(raw) });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url?.includes("sendText") ? { key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true, id: "3EB0ABC" }, status: "PENDING" } : { read: "success" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const sender = createWhatsAppSender({ metaBaseUrl: "http://meta.invalid", metaVersion: "v23.0" });
    const channel = { provider: "EVOLUTION" as const, externalId: INSTANCE, apiBaseUrl: base, accessToken: "chave-evo" };

    const sent = await sender.sendText({ channel, to: PHONE, text: "Olá!" });
    await sender.markRead({ channel, to: PHONE, waMessageId: `evo:${INSTANCE}:IN1` });
    const template = await sender.sendTemplate({ channel, to: PHONE, template: { name: "x", language: "pt_BR" } });
    server.close();

    expect(sent).toEqual({ ok: true, waMessageId: `evo:${INSTANCE}:3EB0ABC` });
    expect(calls).toEqual([
      { url: `/message/sendText/${INSTANCE}`, apikey: "chave-evo", body: { number: PHONE, text: "Olá!" } },
      { url: `/chat/markMessageAsRead/${INSTANCE}`, apikey: "chave-evo", body: { readMessages: [{ remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, id: "IN1" }] } },
    ]);
    expect(template).toMatchObject({ ok: false, errorCode: "template_unsupported", retryable: false });
  });

  it("instância desconectada (4xx) não fica em loop de reenvio; servidor fora do ar (5xx/rede) tenta de novo", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url?.includes("desconectada") ? 400 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: ["instance not connected"] }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sender = createWhatsAppSender({ metaBaseUrl: "http://meta.invalid", metaVersion: "v23.0" });
    const off = await sender.sendText({ channel: { provider: "EVOLUTION", externalId: "desconectada", apiBaseUrl: base, accessToken: "k" }, to: PHONE, text: "x" });
    const down = await sender.sendText({ channel: { provider: "EVOLUTION", externalId: "fora", apiBaseUrl: base, accessToken: "k" }, to: PHONE, text: "x" });
    server.close();
    expect(off).toMatchObject({ ok: false, errorCode: "400", retryable: false });
    expect(down).toMatchObject({ ok: false, errorCode: "503", retryable: true });
  });
});
