import { Hono } from "hono";
import type { Deps } from "../deps.js";
import type { Config } from "../config.js";
import { verifyMetaSignature } from "../lib/signature.js";
import { ingestWebhook } from "../services/inbound.js";
import { adminRoutes } from "./admin.js";
import { log } from "../logger.js";

export interface AppOptions {
  config: Pick<Config, "META_APP_SECRET" | "META_VERIFY_TOKEN" | "ITALOC_SHARED_SECRET">;
  /** false durante o desligamento — healthcheck passa a responder 503. */
  isReady?: () => boolean;
}

export function createApp(deps: Deps, opts: AppOptions) {
  const app = new Hono();

  app.get("/health", async (c) => {
    if (opts.isReady && !opts.isReady()) return c.json({ status: "shutting_down" }, 503);
    try {
      await deps.db.$queryRaw`SELECT 1`;
      return c.json({ status: "ok" });
    } catch {
      return c.json({ status: "db_unavailable" }, 503);
    }
  });

  // Verificação do webhook ao cadastrar na Meta (hub.challenge).
  app.get("/webhooks/whatsapp", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && token && token === opts.config.META_VERIFY_TOKEN && challenge) return c.text(challenge);
    return c.text("Forbidden", 403);
  });

  /**
   * Recebimento. Ordem: valida a assinatura da Meta sobre o corpo CRU →
   * grava → põe na fila → responde 200. IA e Italoc rodam no worker, nunca
   * aqui (a Meta reenvia se a resposta demorar).
   */
  app.post("/webhooks/whatsapp", async (c) => {
    const raw = await c.req.text();
    if (!verifyMetaSignature(opts.config.META_APP_SECRET, raw, c.req.header("x-hub-signature-256"))) {
      log.warn("webhook com assinatura inválida recusado");
      return c.text("Invalid signature", 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.text("Bad request", 400);
    }
    try {
      const summary = await ingestWebhook(deps, body);
      log.info("webhook recebido", summary);
      return c.json({ ok: true });
    } catch (error) {
      // 500 faz a Meta reenviar — seguro, porque a gravação é idempotente por wamid.
      log.error("falha ao registrar webhook", { error: error instanceof Error ? error.message : String(error) });
      return c.text("Error", 500);
    }
  });

  app.route("/admin", adminRoutes(deps, { secret: opts.config.ITALOC_SHARED_SECRET }));

  app.notFound((c) => c.text("Not found", 404));
  app.onError((error, c) => {
    log.error("erro não tratado na API", { path: c.req.path, error: error.message });
    return c.json({ error: "Erro interno." }, 500);
  });

  return app;
}
