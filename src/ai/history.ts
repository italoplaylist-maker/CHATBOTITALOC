import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@prisma/client";
import { messageAsConversationText } from "../whatsapp/webhook.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/**
 * Memória de curto prazo: as últimas mensagens da conversa viram o histórico
 * da IA (cliente = user; bot/atendente = assistant). É isso que faz "e por
 * 10 dias?" se referir à betoneira de antes. Dado permanente (cadastro,
 * preço, locação) nunca vem daqui — sempre do Italoc, na hora.
 *
 * Mensagem de atendente humano entra como fala "nossa", marcada, pra IA
 * saber o que já foi combinado quando a conversa volta pro bot.
 */
export function buildHistory(messages: Pick<Message, "direction" | "author" | "authorName" | "type" | "text" | "payload">[]): MessageParam[] {
  const turns: { role: "user" | "assistant"; parts: string[] }[] = [];
  for (const m of messages) {
    if (m.author === "SYSTEM") continue;
    const role = m.direction === "INBOUND" ? "user" : "assistant";
    const raw = m.direction === "INBOUND" ? messageAsConversationText(m) : (m.text ?? "");
    const text = m.author === "AGENT" ? `[Atendente${m.authorName ? ` ${m.authorName}` : ""}]: ${raw}` : raw;
    if (!text.trim()) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts.push(text);
    else turns.push({ role, parts: [text] });
  }
  // A API exige começar pelo cliente.
  while (turns.length && turns[0].role === "assistant") turns.shift();
  return turns.map((t) => ({ role: t.role, content: t.parts.join("\n") }));
}
