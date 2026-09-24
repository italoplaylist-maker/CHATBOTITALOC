import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Conversation, Channel, ConversationStatus } from "@prisma/client";
import type { Deps } from "../deps.js";
import { COMPANY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyServiceSignature } from "../lib/signature.js";
import { changeStatus, ConversationError, sendOutboundTemplate, sendOutboundText } from "../services/conversation.js";
import { isWithinServiceWindow } from "../whatsapp/client.js";

/**
 * API administrativa usada SÓ pelo servidor do Italoc (painel de
 * atendimento). Nunca pública: toda chamada precisa da assinatura HMAC com
 * o segredo compartilhado, e a empresa assinada no cabeçalho limita tudo —
 * conversa de outra empresa responde 404, como se não existisse.
 */

type Env = { Variables: { companyId: string } };

const actor = z.object({ userId: z.string().min(1).max(100), userName: z.string().min(1).max(120) });

function view(c: Conversation & { channel: Channel }) {
  return {
    id: c.id,
    waId: c.waId,
    contactName: c.contactName,
    status: c.status,
    assignedUserId: c.assignedUserId,
    assignedUserName: c.assignedUserName,
    handoffReason: c.handoffReason,
    lastMessageAt: c.lastMessageAt.toISOString(),
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    unreadCount: c.unreadCount,
    optOut: c.optOut,
    withinServiceWindow: isWithinServiceWindow(c.lastInboundAt),
    channel: { id: c.channel.id, name: c.channel.name, displayPhone: c.channel.displayPhone, botEnabled: c.channel.botEnabled },
  };
}

export function adminRoutes(deps: Deps, opts: { secret: string }) {
  const app = new Hono<Env>();

  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const companyId = c.req.header(COMPANY_HEADER) ?? "";
    const body = c.req.method === "GET" ? "" : await c.req.raw.clone().text();
    const valid =
      companyId.length > 0 &&
      verifyServiceSignature(opts.secret, c.req.header(SIGNATURE_HEADER), {
        timestamp: c.req.header(TIMESTAMP_HEADER) ?? "",
        method: c.req.method,
        path: `${url.pathname}${url.search}`,
        companyId,
        body,
      });
    if (!valid) return c.json({ error: "Não autorizado." }, 401);
    c.set("companyId", companyId);
    await next();
  });

  async function load(c: Context<Env>) {
    const conversation = await deps.db.conversation.findFirst({
      where: { id: c.req.param("id"), companyId: c.get("companyId") },
      include: { channel: true },
    });
    return conversation;
  }

  app.get("/summary", async (c) => {
    const groups = await deps.db.conversation.groupBy({
      by: ["status"],
      where: { companyId: c.get("companyId") },
      _count: { _all: true },
      _sum: { unreadCount: true },
    });
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all])) as Partial<Record<ConversationStatus, number>>;
    return c.json({ byStatus, unread: groups.reduce((s, g) => s + (g._sum.unreadCount ?? 0), 0) });
  });

  app.get("/conversations", async (c) => {
    const status = c.req.query("status");
    const search = c.req.query("search")?.trim();
    const conversations = await deps.db.conversation.findMany({
      where: {
        companyId: c.get("companyId"),
        ...(status && ["BOT", "AWAITING_AGENT", "HUMAN", "CLOSED"].includes(status) ? { status: status as ConversationStatus } : {}),
        ...(search ? { OR: [{ contactName: { contains: search, mode: "insensitive" as const } }, { waId: { contains: search.replace(/\D/g, "") || search } }] } : {}),
      },
      include: { channel: true },
      orderBy: { lastMessageAt: "desc" },
      take: Math.min(Number(c.req.query("limit")) || 100, 200),
    });
    return c.json({ conversations: conversations.map(view) });
  });

  app.get("/conversations/:id", async (c) => {
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    const messages = await deps.db.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return c.json({
      conversation: view(conversation),
      messages: messages.reverse().map((m) => ({
        id: m.id,
        direction: m.direction,
        author: m.author,
        authorName: m.authorName,
        type: m.type,
        text: m.text,
        status: m.status,
        errorCode: m.errorCode,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  });

  app.post("/conversations/:id/read", async (c) => {
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    await deps.db.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
    return c.json({ ok: true });
  });

  /** Atendente assume: a IA para de responder nesta conversa. */
  app.post("/conversations/:id/assume", async (c) => {
    const input = actor.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Parâmetros inválidos." }, 400);
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    const updated = await changeStatus(deps, conversation, "HUMAN", { kind: "agent_assume", ...input.data });
    return c.json({ conversation: view({ ...updated, channel: conversation.channel }) });
  });

  /** Devolve pro atendimento automático — o bot volta a responder a partir da PRÓXIMA mensagem do cliente. */
  app.post("/conversations/:id/release", async (c) => {
    const input = actor.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Parâmetros inválidos." }, 400);
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    // Mensagens que o humano já viu/respondeu não viram pergunta nova pro bot.
    await deps.db.message.updateMany({
      where: { conversationId: conversation.id, direction: "INBOUND", handledAt: null },
      data: { handledAt: new Date() },
    });
    const updated = await changeStatus(deps, conversation, "BOT", { kind: "agent_release", ...input.data });
    return c.json({ conversation: view({ ...updated, channel: conversation.channel }) });
  });

  app.post("/conversations/:id/close", async (c) => {
    const input = actor.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Parâmetros inválidos." }, 400);
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    await deps.db.message.updateMany({
      where: { conversationId: conversation.id, direction: "INBOUND", handledAt: null },
      data: { handledAt: new Date() },
    });
    const updated = await changeStatus(deps, conversation, "CLOSED", { kind: "agent_close", ...input.data });
    await deps.db.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
    return c.json({ conversation: view({ ...updated, unreadCount: 0, channel: conversation.channel }) });
  });

  /** Mensagem do atendente. Quem responde assume a conversa (a IA não fala por cima). */
  app.post("/conversations/:id/messages", async (c) => {
    const input = actor.extend({ text: z.string().trim().min(1).max(4000) }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Parâmetros inválidos." }, 400);
    let conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    if (conversation.status !== "HUMAN" || conversation.assignedUserId !== input.data.userId) {
      const updated = await changeStatus(deps, conversation, "HUMAN", { kind: "agent_assume", userId: input.data.userId, userName: input.data.userName });
      conversation = { ...updated, channel: conversation.channel };
    }
    try {
      const message = await sendOutboundText(deps, conversation, { author: "AGENT", text: input.data.text, authorName: input.data.userName });
      await deps.db.message.updateMany({
        where: { conversationId: conversation.id, direction: "INBOUND", handledAt: null },
        data: { handledAt: new Date() },
      });
      await deps.db.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } });
      return c.json({ message: { id: message.id, status: message.status, errorCode: message.errorCode } });
    } catch (error) {
      if (error instanceof ConversationError) return c.json({ error: error.message, code: error.code }, 422);
      throw error;
    }
  });

  /** Fora da janela de 24h: só modelo aprovado na Meta. */
  app.post("/conversations/:id/template", async (c) => {
    const input = actor
      .extend({ name: z.string().regex(/^[a-z0-9_]+$/).max(512), language: z.string().min(2).max(10), bodyParams: z.array(z.string().max(1000)).max(10).default([]) })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "Parâmetros inválidos." }, 400);
    const conversation = await load(c);
    if (!conversation) return c.json({ error: "Conversa não encontrada." }, 404);
    if (conversation.optOut) return c.json({ error: "Este contato pediu para não receber mensagens ativas.", code: "opt_out" }, 422);
    const message = await sendOutboundTemplate(deps, conversation, {
      template: { name: input.data.name, language: input.data.language, bodyParams: input.data.bodyParams },
      authorName: input.data.userName,
    });
    return c.json({ message: { id: message.id, status: message.status, errorCode: message.errorCode } });
  });

  return app;
}
