import { Prisma, type Job } from "@prisma/client";
import type { Db } from "../db.js";

/**
 * Fila de trabalho no próprio Postgres — sem Redis, proporcional ao porte:
 *
 * - enqueue com dedupeKey: no máximo UM job pendente por chave (ex: uma
 *   resposta pendente por conversa). Dez mensagens seguidas do cliente viram
 *   um job só, que responde todas de uma vez.
 * - claim com FOR UPDATE SKIP LOCKED: vários workers (ou várias réplicas)
 *   nunca pegam o mesmo job.
 * - serialização por conversa: um job não é pego enquanto outro da MESMA
 *   conversa está rodando — duas respostas da IA nunca correm em paralelo
 *   pro mesmo cliente.
 */

export const REPLY_JOB = "conversation.reply";
export const SEND_JOB = "message.send";
export const STALE_LOCK_MS = 5 * 60 * 1000;

export async function enqueueJob(
  db: Db,
  input: { type: string; conversationId?: string | null; dedupeKey?: string | null; payload?: Prisma.InputJsonValue; runAt?: Date; maxAttempts?: number },
): Promise<void> {
  await db.job.createMany({
    data: [
      {
        type: input.type,
        conversationId: input.conversationId ?? null,
        dedupeKey: input.dedupeKey ?? null,
        payload: input.payload ?? Prisma.JsonNull,
        runAt: input.runAt ?? new Date(),
        maxAttempts: input.maxAttempts ?? 3,
      },
    ],
    // Já existe pendente com a mesma chave: ele vai cobrir esta também.
    skipDuplicates: true,
  });
}

export function replyDedupeKey(conversationId: string) {
  return `reply:${conversationId}`;
}

export async function claimNextJob(db: Db): Promise<Job | null> {
  const rows = await db.$queryRaw<Job[]>`
    UPDATE "Job" SET status = 'RUNNING', "lockedAt" = now(), attempts = attempts + 1, "dedupeKey" = NULL, "updatedAt" = now()
    WHERE id = (
      SELECT j.id FROM "Job" j
      WHERE j.status = 'PENDING' AND j."runAt" <= now()
        AND (j."conversationId" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "Job" r WHERE r."conversationId" = j."conversationId" AND r.status = 'RUNNING'
        ))
      ORDER BY j."runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.job.update({ where: { id }, data: { status: "DONE", lockedAt: null } });
}

/** Backoff exponencial: 5s, 20s, 80s... */
export function retryDelayMs(attempts: number): number {
  return 5000 * 4 ** Math.max(0, attempts - 1);
}

/**
 * Falhou: volta pra fila com espera ou, esgotadas as tentativas, fica FAILED.
 * Se enquanto isso já entrou outro pendente da mesma conversa, este se
 * encerra — o pendente novo cobre o mesmo trabalho (resposta de todas as
 * mensagens ainda não respondidas).
 * Devolve true quando foi a ÚLTIMA tentativa (quem chamou decide o fallback).
 */
export async function failJob(db: Db, job: Job, error: string, opts: { retryable: boolean; dedupeKey?: string | null }): Promise<boolean> {
  const lastError = error.slice(0, 1000);
  const final = !opts.retryable || job.attempts >= job.maxAttempts;
  if (final) {
    await db.job.update({ where: { id: job.id }, data: { status: "FAILED", lastError, lockedAt: null } });
    return true;
  }
  try {
    await db.job.update({
      where: { id: job.id },
      data: { status: "PENDING", lastError, lockedAt: null, dedupeKey: opts.dedupeKey ?? null, runAt: new Date(Date.now() + retryDelayMs(job.attempts)) },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await db.job.update({ where: { id: job.id }, data: { status: "DONE", lastError: `${lastError} (coberto por job mais novo)`, lockedAt: null } });
      return false;
    }
    throw e;
  }
  return false;
}

/** Job preso em RUNNING (processo morreu no meio) volta pra fila. */
export async function recoverStaleJobs(db: Db, now: Date = new Date()): Promise<number> {
  const stale = await db.job.findMany({ where: { status: "RUNNING", lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } } });
  for (const job of stale) {
    const dedupeKey = job.type === REPLY_JOB && job.conversationId ? replyDedupeKey(job.conversationId) : null;
    await failJob(db, job, "processo interrompido durante a execução", { retryable: true, dedupeKey });
  }
  return stale.length;
}
