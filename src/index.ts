import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { log, setLogLevel } from "./logger.js";
import { prisma } from "./db.js";
import { createApp } from "./http/app.js";
import { createWhatsAppSender } from "./whatsapp/client.js";
import { createItalocClient } from "./italoc/client.js";
import { createAnthropicAiClient } from "./ai/agent.js";
import { startWorker } from "./queue/worker.js";
import type { Deps } from "./deps.js";

async function main() {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  const deps: Deps = {
    db: prisma,
    config,
    whatsapp: createWhatsAppSender({ baseUrl: config.META_GRAPH_BASE_URL, version: config.META_GRAPH_VERSION }),
    italoc: createItalocClient({ baseUrl: config.ITALOC_BASE_URL, secret: config.ITALOC_SHARED_SECRET, timeoutMs: config.ITALOC_TIMEOUT_MS }),
    ai: createAnthropicAiClient({ timeoutMs: config.AI_TIMEOUT_MS }),
  };

  let ready = true;
  const app = createApp(deps, { config, isReady: () => ready });
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => log.info("CHATBOTITALOC no ar", { port: info.port }));
  const worker = startWorker(deps, { concurrency: config.WORKER_CONCURRENCY, pollMs: config.WORKER_POLL_MS });

  // Limpeza periódica do corpo cru dos webhooks (retenção configurável).
  const retention = setInterval(() => {
    const cutoff = new Date(Date.now() - config.WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: cutoff } } }).catch(() => undefined);
  }, 6 * 60 * 60 * 1000);

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    log.info("desligando", { signal });
    clearInterval(retention);
    server.close();
    // Termina o que está em andamento (resposta da IA no meio) antes de sair.
    await worker.stop();
    await prisma.$disconnect();
    process.exit(0);
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error) => {
  log.error("falha ao iniciar", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
