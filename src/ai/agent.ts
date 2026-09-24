import Anthropic from "@anthropic-ai/sdk";
import { executeTool, TOOL_DEFINITIONS, type ToolContext } from "./tools.js";
import { SYSTEM_PROMPT, contextBlock, type ConversationContext } from "./prompt.js";
import type { ItalocApi } from "../italoc/client.js";

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** Porta pra IA — produção usa o SDK da Anthropic; teste usa um dublê. */
export interface AiClient {
  createMessage(params: CreateParams): Promise<BetaMessage>;
}

export function createAnthropicAiClient(opts: { timeoutMs: number }): AiClient {
  // maxRetries 2: o SDK já refaz 429/5xx/queda de rede com backoff.
  const client = new Anthropic({ timeout: opts.timeoutMs, maxRetries: 2 });
  return { createMessage: (params) => client.beta.messages.create(params) };
}

/** A IA não respondeu (API fora, sem crédito, timeout...) — quem chamou manda a mensagem de fallback e chama um atendente. */
export class AiUnavailableError extends Error {}

export interface ToolCallLog {
  name: string;
  input: unknown;
  ok: boolean;
  error: string | null;
  latencyMs: number;
}

export interface AgentResult {
  /** Texto final pro cliente (null = nada a enviar). */
  reply: string | null;
  handoffReason: string | null;
  outcome: "replied" | "handoff" | "fallback";
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  toolCalls: ToolCallLog[];
  error: string | null;
}

export interface AgentInput {
  model: string;
  effort: "low" | "medium" | "high";
  maxToolRounds: number;
  history: MessageParam[];
  context: ConversationContext;
  toolContext: ToolContext;
}

function finalText(message: BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/**
 * Um turno de atendimento: chama o modelo, executa as ferramentas pedidas,
 * devolve os resultados e repete até o modelo responder o cliente (ou
 * estourar o limite de rodadas). Loop manual pra ter controle total: cada
 * ferramenta roda com o contexto da conversa (empresa, telefone) que a IA
 * não pode mudar, e tudo é registrado (ai_runs/tool_calls).
 */
export async function runAgent(ai: AiClient, italoc: ItalocApi, input: AgentInput): Promise<AgentResult> {
  const messages: MessageParam[] = [...input.history];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const toolCalls: ToolCallLog[] = [];
  let handoffReason: string | null = null;
  let stopReason: string | null = null;

  for (let round = 0; round <= input.maxToolRounds; round++) {
    let response: BetaMessage;
    try {
      response = await ai.createMessage({
        model: input.model,
        max_tokens: 16000,
        // Prompt fixo com cache (ferramentas + sistema são o prefixo estável);
        // o contexto da conversa vem depois do ponto de cache.
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          { type: "text", text: contextBlock(input.context) },
        ],
        tools: TOOL_DEFINITIONS,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: input.effort },
        // Recusa do modelo principal é refeita pelo modelo recomendado pela
        // Anthropic pra aquela categoria, no mesmo request.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (error) {
      if (error instanceof Anthropic.APIError) throw new AiUnavailableError(`API da IA respondeu ${error.status ?? "erro"}: ${error.message}`);
      throw new AiUnavailableError(error instanceof Error ? error.message : "falha ao chamar a IA");
    }

    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    stopReason = response.stop_reason;

    if (response.stop_reason === "refusal") {
      return { reply: null, handoffReason: "A IA não pôde responder a esta conversa.", outcome: "fallback", stopReason, usage, toolCalls, error: "refusal" };
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");

    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      if (response.stop_reason === "max_tokens") {
        return { reply: null, handoffReason: "Resposta da IA foi interrompida.", outcome: "fallback", stopReason, usage, toolCalls, error: "max_tokens" };
      }
      const text = finalText(response);
      if (!text) {
        return handoffReason
          ? { reply: null, handoffReason, outcome: "handoff", stopReason, usage, toolCalls, error: null }
          : { reply: null, handoffReason: "A IA não produziu resposta.", outcome: "fallback", stopReason, usage, toolCalls, error: "empty_reply" };
      }
      return { reply: text, handoffReason, outcome: handoffReason ? "handoff" : "replied", stopReason, usage, toolCalls, error: null };
    }

    messages.push({ role: "assistant", content: response.content });

    // Várias ferramentas no mesmo turno rodam juntas e voltam numa única mensagem.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        const started = Date.now();
        const outcome = await executeTool(italoc, input.toolContext, block.name, block.input);
        toolCalls.push({
          name: block.name,
          input: block.input,
          ok: !outcome.isError,
          error: outcome.isError ? outcome.content.slice(0, 500) : null,
          latencyMs: Date.now() - started,
        });
        if (outcome.handoffReason) handoffReason = outcome.handoffReason;
        return { type: "tool_result" as const, tool_use_id: block.id, content: outcome.content, is_error: outcome.isError };
      }),
    );
    messages.push({ role: "user", content: results });
  }

  return {
    reply: null,
    handoffReason: handoffReason ?? "A IA não concluiu a resposta dentro do limite de consultas.",
    outcome: "fallback",
    stopReason,
    usage,
    toolCalls,
    error: "max_tool_rounds",
  };
}
