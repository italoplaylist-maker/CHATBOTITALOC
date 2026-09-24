import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM pro token de acesso da Meta guardado no banco (mesmo formato
 * do Italoc pras credenciais Pix: "v1:<iv>:<tag>:<cifra>", base64). A chave
 * mestra vem de CHANNEL_TOKEN_KEY e nunca vai pro banco.
 */
export function encryptSecret(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(envelope: string, keyBase64: string): string {
  const [version, iv, tag, data] = envelope.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Segredo em formato desconhecido.");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

/** Segredo novo pra URL do webhook da Evolution (só aparece uma vez, na hora do cadastro). */
export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/** O banco guarda só o hash do segredo da URL — vazou o banco, não vazou a URL. */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
