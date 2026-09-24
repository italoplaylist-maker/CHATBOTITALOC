import { prisma } from "../db.js";
import { encryptSecret, generateWebhookToken, hashWebhookToken } from "../lib/crypto.js";

/**
 * Cadastra/atualiza um número de WhatsApp (Channel) ligado a uma empresa do
 * Italoc. Credenciais vêm de variável de ambiente (nunca por argumento, que
 * fica no histórico do shell) e são gravadas criptografadas.
 *
 * Evolution API (o mesmo servidor/instância que o Italoc já usa):
 *
 *   EVOLUTION_API_KEY=... npm run channel:upsert -- --provider evolution \
 *     --company <companyId do Italoc> --instance <nome da instância> \
 *     --evolution-url https://evolution.suaempresa.com.br \
 *     --webhook-base https://bot.suaempresa.com.br --name "Empresa X"
 *
 *   Gera um segredo novo pra URL do webhook, guarda só o hash e configura o
 *   webhook na instância (POST /webhook/set). Rodar de novo troca o segredo.
 *
 * Meta (Cloud API oficial):
 *
 *   CHANNEL_ACCESS_TOKEN=... npm run channel:upsert -- \
 *     --company <companyId> --phone-number-id <id da Meta> --name "Empresa X"
 *
 * Opcionais: --display "+55 11 99999-9999", --bot off (só atendimento humano).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function configureEvolutionWebhook(baseUrl: string, instance: string, apiKey: string, url: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/webhook/set/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({ webhook: { enabled: true, url, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE"] } }),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    return `Evolution respondeu ${res.status}${body.message ? `: ${JSON.stringify(body.message)}` : ""}`;
  } catch (error) {
    return error instanceof Error ? error.message : "falha de rede";
  }
}

async function main() {
  const provider = (arg("provider") ?? "meta").toUpperCase();
  const companyId = arg("company");
  const name = arg("name");
  const key = process.env.CHANNEL_TOKEN_KEY;
  if (provider !== "META" && provider !== "EVOLUTION") throw new Error("--provider deve ser meta ou evolution.");
  if (!companyId || !name) throw new Error("Informe --company e --name.");
  if (!key) throw new Error("Defina CHANNEL_TOKEN_KEY no ambiente.");

  const common = { companyId, name, displayPhone: arg("display") ?? null, botEnabled: arg("bot") !== "off", active: true };

  if (provider === "META") {
    const phoneNumberId = arg("phone-number-id");
    const token = process.env.CHANNEL_ACCESS_TOKEN;
    if (!phoneNumberId) throw new Error("Informe --phone-number-id.");
    if (!token) throw new Error("Defina CHANNEL_ACCESS_TOKEN no ambiente.");
    const data = { ...common, provider: "META" as const, apiBaseUrl: null, webhookTokenHash: null, accessTokenEnc: encryptSecret(token, key) };
    const channel = await prisma.channel.upsert({ where: { phoneNumberId }, create: { phoneNumberId, ...data }, update: data });
    console.log(`Canal Meta ${channel.name} (${channel.phoneNumberId}) salvo para a empresa ${channel.companyId}. Bot ${channel.botEnabled ? "ligado" : "desligado"}.`);
    return;
  }

  const instance = arg("instance");
  const evolutionUrl = arg("evolution-url");
  const webhookBase = arg("webhook-base");
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!instance || !evolutionUrl || !webhookBase) throw new Error("Informe --instance, --evolution-url e --webhook-base.");
  if (!apiKey) throw new Error("Defina EVOLUTION_API_KEY no ambiente.");

  const webhookToken = generateWebhookToken();
  const data = {
    ...common,
    provider: "EVOLUTION" as const,
    apiBaseUrl: evolutionUrl.replace(/\/+$/, ""),
    accessTokenEnc: encryptSecret(apiKey, key),
    webhookTokenHash: hashWebhookToken(webhookToken),
  };
  const channel = await prisma.channel.upsert({ where: { phoneNumberId: instance }, create: { phoneNumberId: instance, ...data }, update: data });
  const webhookUrl = `${webhookBase.replace(/\/+$/, "")}/webhooks/evolution/${webhookToken}`;

  console.log(`Canal Evolution ${channel.name} (instância ${instance}) salvo para a empresa ${channel.companyId}. Bot ${channel.botEnabled ? "ligado" : "desligado"}.`);
  const error = await configureEvolutionWebhook(evolutionUrl, instance, apiKey, webhookUrl);
  if (!error) {
    console.log("Webhook configurado na instância (eventos MESSAGES_UPSERT e MESSAGES_UPDATE).");
  } else {
    // A URL tem o segredo: só aparece aqui, pra configurar à mão, e não fica guardada.
    console.log(`Não consegui configurar o webhook automaticamente (${error}).`);
    console.log("Configure no painel da Evolution (Webhook da instância), eventos MESSAGES_UPSERT e MESSAGES_UPDATE, com a URL:");
    console.log(webhookUrl);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
