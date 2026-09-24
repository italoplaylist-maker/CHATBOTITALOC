/**
 * Log estruturado em JSON (uma linha por evento — o Coolify/Docker coleta do
 * stdout). Campos com nome de segredo são mascarados SEMPRE, em qualquer
 * profundidade: token, secret, senha, authorization, chave, copia-e-cola do
 * Pix. Conteúdo de mensagem do cliente não é logado — só ids e tamanhos.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(token|secret|password|senha|authorization|api[-_]?key|signature|cookie|copiaecola|accesstoken)/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[profundo]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: value.message };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

let minLevel: Level = "info";
export function setLogLevel(level: Level) {
  minLevel = level;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...(fields ? (redact(fields) as object) : {}) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};
