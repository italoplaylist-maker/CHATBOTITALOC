import { prisma } from "../db.js";
import { encryptSecret } from "../lib/crypto.js";

/**
 * Cadastra/atualiza um número de WhatsApp (Channel) ligado a uma empresa do
 * Italoc. O token vem de variável de ambiente (nunca por argumento, que fica
 * no histórico do shell) e é gravado criptografado.
 *
 *   CHANNEL_ACCESS_TOKEN=... npm run channel:upsert -- \
 *     --company <companyId do Italoc> --phone-number-id <id da Meta> \
 *     --name "Empresa X" [--display "+55 11 99999-9999"] [--bot off]
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const companyId = arg("company");
  const phoneNumberId = arg("phone-number-id");
  const name = arg("name");
  const token = process.env.CHANNEL_ACCESS_TOKEN;
  const key = process.env.CHANNEL_TOKEN_KEY;
  if (!companyId || !phoneNumberId || !name) throw new Error("Informe --company, --phone-number-id e --name.");
  if (!token) throw new Error("Defina CHANNEL_ACCESS_TOKEN no ambiente.");
  if (!key) throw new Error("Defina CHANNEL_TOKEN_KEY no ambiente.");

  const data = {
    companyId,
    name,
    displayPhone: arg("display") ?? null,
    accessTokenEnc: encryptSecret(token, key),
    botEnabled: arg("bot") !== "off",
    active: true,
  };
  const channel = await prisma.channel.upsert({ where: { phoneNumberId }, create: { phoneNumberId, ...data }, update: data });
  console.log(`Canal ${channel.name} (${channel.phoneNumberId}) salvo para a empresa ${channel.companyId}. Bot ${channel.botEnabled ? "ligado" : "desligado"}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
