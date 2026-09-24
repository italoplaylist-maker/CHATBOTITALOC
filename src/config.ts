import { z } from "zod";

/**
 * Toda configuração vem de variável de ambiente, validada na subida — o
 * processo nem começa com configuração faltando ou inválida (melhor falhar no
 * deploy do que no meio de uma conversa). Nenhum segredo tem valor padrão.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().min(1),

  // Meta / WhatsApp Cloud API
  META_APP_SECRET: z.string().min(16),
  META_VERIFY_TOKEN: z.string().min(16),
  META_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
  /** 32 bytes em base64 — criptografa os tokens de acesso dos números (Channel.accessTokenEnc). */
  CHANNEL_TOKEN_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, "CHANNEL_TOKEN_KEY precisa ter 32 bytes em base64."),

  // Italoc
  ITALOC_BASE_URL: z.string().url(),
  /** Mesmo valor de CHATBOT_API_SECRET no Italoc — assina as chamadas nos dois sentidos. */
  ITALOC_SHARED_SECRET: z.string().min(32),
  ITALOC_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  // IA (Anthropic). ANTHROPIC_API_KEY é lida pelo próprio SDK.
  ANTHROPIC_API_KEY: z.string().min(1),
  /** Padrão: Haiku 4.5, o mais barato. claude-opus-5 responde com mais cuidado, custando ~5x mais. */
  AI_MODEL: z.string().default("claude-haiku-4-5"),
  /** Só vale pros modelos que aceitam effort (Opus/Sonnet atuais) — o Haiku 4.5 ignora. */
  AI_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  AI_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(8),
  AI_HISTORY_MESSAGES: z.coerce.number().int().min(4).max(100).default(30),

  // Fila
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Só o NOME da variável com problema — nunca o valor.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${problems}`);
  }
  return parsed.data;
}
