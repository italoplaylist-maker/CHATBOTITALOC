import type { Job } from "@prisma/client";
import type { Deps } from "../deps.js";
import { claimNextJob, completeJob, failJob, recoverStaleJobs, REPLY_JOB, replyDedupeKey, SEND_JOB } from "./jobs.js";
import { processReplyJob, replyFallbackAfterFailure } from "../services/reply.js";
import { deliverMessage } from "../services/conversation.js";
import { log } from "../logger.js";

/**
 * Worker da fila: N laços concorrentes pegando jobs. Para de pegar job novo
 * quando recebe stop() e espera os que estão rodando terminarem (shutdown
 * limpo no redeploy do Coolify).
 */
export async function runJob(deps: Deps, job: Job): Promise<void> {
  try {
    if (job.type === REPLY_JOB) await processReplyJob(deps, job);
    else if (job.type === SEND_JOB) await processSendJob(deps, job);
    else log.warn("tipo de job desconhecido", { jobId: job.id, type: job.type });
    await completeJob(deps.db, job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Erro marcado explicitamente como definitivo não volta pra fila; o resto tenta de novo.
    const retryable = (error as { retryable?: boolean } | null)?.retryable !== false;
    const dedupeKey = job.type === REPLY_JOB && job.conversationId ? replyDedupeKey(job.conversationId) : null;
    const final = await failJob(deps.db, job, message, { retryable, dedupeKey });
    log.error("job falhou", { jobId: job.id, type: job.type, attempts: job.attempts, final, error: message });
    if (final && job.type === REPLY_JOB && job.conversationId) {
      await replyFallbackAfterFailure(deps, job.conversationId).catch((e) =>
        log.error("fallback após falha também falhou", { conversationId: job.conversationId, error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }
}

async function processSendJob(deps: Deps, job: Job) {
  const { messageId } = (job.payload ?? {}) as { messageId?: string };
  if (!messageId || !job.conversationId) return;
  const conversation = await deps.db.conversation.findUnique({ where: { id: job.conversationId }, include: { channel: true } });
  if (!conversation) return;
  const result = await deliverMessage(deps, messageId, conversation);
  if (!result.ok && result.retryable) throw Object.assign(new Error("reenvio falhou"), { retryable: true });
}

export function startWorker(deps: Deps, opts: { concurrency: number; pollMs: number }) {
  let stopping = false;
  const running = new Set<Promise<void>>();

  async function loop() {
    while (!stopping) {
      let job: Job | null = null;
      try {
        job = await claimNextJob(deps.db);
      } catch (error) {
        log.error("falha ao buscar job", { error: error instanceof Error ? error.message : String(error) });
      }
      if (!job) {
        await new Promise((r) => setTimeout(r, opts.pollMs));
        continue;
      }
      await runJob(deps, job);
    }
  }

  const maintenance = setInterval(() => {
    recoverStaleJobs(deps.db).catch((e) => log.error("recuperação de jobs falhou", { error: e instanceof Error ? e.message : String(e) }));
  }, 60_000);
  recoverStaleJobs(deps.db).catch(() => undefined);

  for (let i = 0; i < opts.concurrency; i++) {
    const p = loop();
    running.add(p);
    p.finally(() => running.delete(p));
  }

  return {
    async stop() {
      stopping = true;
      clearInterval(maintenance);
      await Promise.allSettled([...running]);
    },
  };
}
