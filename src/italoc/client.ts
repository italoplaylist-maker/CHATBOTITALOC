import { COMPANY_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signServiceRequest } from "../lib/signature.js";

/**
 * Cliente da API interna do Italoc (/api/internal/chatbot/<ação>). Toda
 * chamada é assinada com o segredo compartilhado e carrega a empresa do
 * número de WhatsApp que recebeu a mensagem — o Italoc só responde dentro
 * daquela empresa.
 */
export type ItalocResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; retryable: boolean };

export interface ItalocApi {
  call<T = unknown>(companyId: string, action: string, body: Record<string, unknown>): Promise<ItalocResult<T>>;
}

export function createItalocClient(opts: { baseUrl: string; secret: string; timeoutMs: number }): ItalocApi {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async call<T>(companyId: string, action: string, body: Record<string, unknown>): Promise<ItalocResult<T>> {
      const path = `/api/internal/chatbot/${encodeURIComponent(action)}`;
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = signServiceRequest(opts.secret, { timestamp, method: "POST", path, companyId, body: raw });
      try {
        const res = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [TIMESTAMP_HEADER]: timestamp,
            [SIGNATURE_HEADER]: signature,
            [COMPANY_HEADER]: companyId,
          },
          body: raw,
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: T; code?: string; error?: string } | null;
        if (res.ok && json?.ok) return { ok: true, data: json.data as T };
        return {
          ok: false,
          code: json?.code ?? `http_${res.status}`,
          error: json?.error ?? `Italoc respondeu ${res.status}`,
          retryable: res.status >= 500 || res.status === 429,
        };
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, code: timeout ? "timeout" : "network_error", error: timeout ? "Tempo esgotado ao consultar o sistema." : "Sistema indisponível no momento.", retryable: true };
      }
    },
  };
}
