import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { WhatsAppSender } from "./whatsapp/client.js";
import type { ItalocApi } from "./italoc/client.js";
import type { AiClient } from "./ai/agent.js";

/** Tudo que os serviços usam de fora — injetado, pra teste trocar Meta/Italoc/IA por dublês. */
export interface Deps {
  db: Db;
  config: Pick<Config, "CHANNEL_TOKEN_KEY" | "AI_MODEL" | "AI_EFFORT" | "AI_TIMEOUT_MS" | "AI_MAX_TOOL_ROUNDS" | "AI_HISTORY_MESSAGES">;
  whatsapp: WhatsAppSender;
  italoc: ItalocApi;
  ai: AiClient;
}
