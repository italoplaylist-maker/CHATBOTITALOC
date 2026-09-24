import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Assinatura das chamadas entre CHATBOTITALOC e Italoc (nos dois sentidos).
 * Cópia exata do contrato em lib/service-signature.ts do Italoc — se mudar
 * lá, muda aqui. Cobre timestamp, método, caminho (com query), empresa e
 * corpo, então uma chamada assinada não serve pra outra rota nem pra outra
 * empresa.
 */
export const SIGNATURE_HEADER = "x-italoc-signature";
export const TIMESTAMP_HEADER = "x-italoc-timestamp";
export const COMPANY_HEADER = "x-italoc-company-id";
export const MAX_SIGNATURE_SKEW_SECONDS = 300;

export interface SignatureParts {
  timestamp: string;
  method: string;
  path: string;
  companyId: string;
  body: string;
}

export function signServiceRequest(secret: string, parts: SignatureParts): string {
  const payload = ["v1", parts.timestamp, parts.method.toUpperCase(), parts.path, parts.companyId, parts.body].join("\n");
  return `v1=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyServiceSignature(
  secret: string,
  signature: string | null | undefined,
  parts: SignatureParts,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!signature || !/^\d+$/.test(parts.timestamp)) return false;
  if (Math.abs(nowSeconds - Number(parts.timestamp)) > MAX_SIGNATURE_SKEW_SECONDS) return false;
  const expected = Buffer.from(signServiceRequest(secret, parts));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Assinatura do webhook da Meta: X-Hub-Signature-256 = "sha256=" + HMAC(app secret, corpo cru). */
export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
