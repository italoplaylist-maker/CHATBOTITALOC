import { createHash } from "node:crypto";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { ItalocApi } from "../italoc/client.js";

/**
 * Ferramentas que a IA pode usar. Todas consultam o Italoc — o chatbot não
 * tem dado comercial próprio.
 *
 * Segurança por construção: NENHUMA ferramenta recebe telefone, id de
 * cliente ou id de empresa. Esses vêm do ToolContext, preenchido pelo
 * serviço a partir do número que o WhatsApp informou e do número de
 * WhatsApp da empresa que recebeu a mensagem. A IA pode ser convencida a
 * "pedir a locação do fulano" — mas não tem como expressar isso numa
 * chamada.
 *
 * Níveis (seção 8 do escopo):
 * - leitura: automática.
 * - criação controlada: registrar interesse, criar orçamento com preço
 *   calculado pelo Italoc, registrar aprovação (que só avisa o escritório),
 *   gerar Pix do saldo existente.
 * - ações sensíveis (baixa, cancelamento, alteração de contrato/preço,
 *   desconto, exclusão, financeiro): não existem como ferramenta.
 */

export interface ToolContext {
  companyId: string;
  phone: string;
  conversationId: string;
  contactName: string | null;
  /** wamid da última mensagem do cliente sendo respondida — base da idempotência. */
  triggerMessageId: string;
}

export interface ToolOutcome {
  /** Conteúdo devolvido à IA (JSON em texto). */
  content: string;
  isError: boolean;
  /** Só transferir_para_atendente preenche. */
  handoffReason?: string;
}

const nullableString = { type: ["string", "null"] } as const;
const dateField = { type: "string", description: "Data no formato AAAA-MM-DD." } as const;
const deliveryField = {
  type: "string",
  enum: ["ENTREGA", "CLIENTE_RETIRA"],
  description: "ENTREGA = a empresa leva até a obra; CLIENTE_RETIRA = o cliente busca.",
} as const;
const itemsField = {
  type: "array",
  description: "Itens do pedido.",
  items: {
    type: "object",
    properties: {
      ref: { type: "string", description: "Referência do equipamento devolvida por buscar_equipamento (ex: tool:...)." },
      quantidade: { type: "number", description: "Quantidade. Para munck por hora, número de horas." },
      munck_por_hora: { type: "boolean", description: "Só para munck: true cobra por hora, false por diária." },
    },
    required: ["ref", "quantidade", "munck_por_hora"],
    additionalProperties: false,
  },
} as const;
const periodField = {
  anyOf: [{ type: "string", enum: ["DAILY", "WEEKEND", "WEEKLY", "BIWEEKLY", "MONTHLY"] }, { type: "null" }],
  description: "Force um período de cobrança só se o cliente pedir (ex: WEEKEND = pacote de sexta a segunda). null = o sistema escolhe o mais vantajoso.",
} as const;

export const TOOL_DEFINITIONS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "consultar_cliente",
    description: "Verifica se o número desta conversa pertence a um cliente cadastrado e se há atendimento/orçamento em aberto.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "buscar_equipamento",
    description:
      "Procura equipamentos da empresa pelo nome (ex: 'betoneira', 'andaime', 'caçamba 5m'). Com termo, devolve até 8 resultados com a quantidade disponível hoje e a tabela de preço. Com termo null, lista todos os nomes.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { termo: { ...nullableString, description: "O que o cliente procura, ou null para listar tudo." } },
      required: ["termo"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_disponibilidade",
    description: "Quantas unidades de um equipamento estão livres num período.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { ref: { type: "string" }, data_inicio: dateField, data_fim: dateField, quantidade: { type: "number" } },
      required: ["ref", "data_inicio", "data_fim", "quantidade"],
      additionalProperties: false,
    },
  },
  {
    name: "listar_bairros_atendidos",
    description: "Lista os bairros com frete cadastrado (onde a empresa entrega e tem preço de frete/caçamba).",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "calcular_orcamento",
    description:
      "Calcula o valor real de um pedido pela tabela da empresa: período cobrado, valor de cada item, frete e total, além da disponibilidade. Não grava nada. 'faltando' lista o que ainda é preciso saber (ex: bairro).",
    strict: true,
    input_schema: {
      type: "object",
      properties: { itens: itemsField, data_inicio: dateField, data_fim: dateField, entrega: deliveryField, bairro: nullableString, periodo: periodField },
      required: ["itens", "data_inicio", "data_fim", "entrega", "bairro", "periodo"],
      additionalProperties: false,
    },
  },
  {
    name: "criar_orcamento",
    description:
      "Registra um orçamento formal no sistema com os valores calculados pela tabela da empresa e devolve o número (ORC-...). Use quando o cliente quiser formalizar. Se faltar informação ou estoque, nada é criado e a resposta diz o que falta.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        itens: itemsField,
        data_inicio: dateField,
        data_fim: dateField,
        entrega: deliveryField,
        bairro: nullableString,
        periodo: periodField,
        nome_contato: { ...nullableString, description: "Nome da pessoa, se ela informou." },
        endereco: { ...nullableString, description: "Endereço/obra informado pelo cliente, se houver." },
      },
      required: ["itens", "data_inicio", "data_fim", "entrega", "bairro", "periodo", "nome_contato", "endereco"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_orcamentos",
    description: "Últimos orçamentos deste número, com itens, valores e situação.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "registrar_aprovacao_orcamento",
    description:
      "Registra que o cliente aprovou um orçamento e avisa o escritório. NÃO confirma a locação: um atendente confirma a reserva e combina a entrega.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { numero_orcamento: { type: "integer", description: "Número do orçamento (ORC-000123 → 123)." } },
      required: ["numero_orcamento"],
      additionalProperties: false,
    },
  },
  {
    name: "consultar_locacoes",
    description: "Locações em andamento do cliente deste número (situação, obra, datas, itens). Só para cliente cadastrado.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "consultar_saldo",
    description: "Valores em aberto do cliente deste número, por locação. Só para cliente cadastrado.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "gerar_pix",
    description: "Gera (ou reaproveita) a cobrança Pix do saldo em aberto de UMA locação do cliente e devolve o código copia e cola.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { numero_locacao: { type: "integer", description: "Número da locação (LOC-000245 → 245)." } },
      required: ["numero_locacao"],
      additionalProperties: false,
    },
  },
  {
    name: "registrar_interesse",
    description: "Registra no funil comercial o interesse de um contato (o que procura, para quando). Não cria cliente.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { resumo: { type: "string", description: "Resumo curto do interesse." }, nome_contato: nullableString },
      required: ["resumo", "nome_contato"],
      additionalProperties: false,
    },
  },
  {
    name: "transferir_para_atendente",
    description: "Passa a conversa para um atendente humano e avisa o escritório. Depois disso você não responde mais nesta conversa.",
    strict: true,
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string", description: "Por que precisa de atendente, em uma frase." } },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

// Validação local de cada entrada (strict já garante o formato; isto é a
// segunda trava e dá o tipo certo ao código).
const itemSchema = z.object({ ref: z.string(), quantidade: z.number().positive(), munck_por_hora: z.boolean() });
const pricingSchema = z.object({
  itens: z.array(itemSchema).min(1),
  data_inicio: z.string(),
  data_fim: z.string(),
  entrega: z.enum(["ENTREGA", "CLIENTE_RETIRA"]),
  bairro: z.string().nullable(),
  periodo: z.enum(["DAILY", "WEEKEND", "WEEKLY", "BIWEEKLY", "MONTHLY"]).nullable(),
});
const inputSchemas: Record<string, z.ZodType> = {
  consultar_cliente: z.object({}),
  buscar_equipamento: z.object({ termo: z.string().nullable() }),
  consultar_disponibilidade: z.object({ ref: z.string(), data_inicio: z.string(), data_fim: z.string(), quantidade: z.number().positive() }),
  listar_bairros_atendidos: z.object({}),
  calcular_orcamento: pricingSchema,
  criar_orcamento: pricingSchema.extend({ nome_contato: z.string().nullable(), endereco: z.string().nullable() }),
  consultar_orcamentos: z.object({}),
  registrar_aprovacao_orcamento: z.object({ numero_orcamento: z.number().int().positive() }),
  consultar_locacoes: z.object({}),
  consultar_saldo: z.object({}),
  gerar_pix: z.object({ numero_locacao: z.number().int().positive() }),
  registrar_interesse: z.object({ resumo: z.string().min(1), nome_contato: z.string().nullable() }),
  transferir_para_atendente: z.object({ motivo: z.string().min(1) }),
};

function pricingBody(input: z.infer<typeof pricingSchema>) {
  return {
    items: input.itens.map((i) => ({ ref: i.ref, quantity: i.quantidade, munckHourly: i.munck_por_hora })),
    startDate: input.data_inicio,
    endDate: input.data_fim,
    deliveryMethod: input.entrega === "ENTREGA" ? "DELIVER" : "PICKUP_BY_CUSTOMER",
    neighborhood: input.bairro,
    period: input.periodo,
  };
}

/** Chave estável: a mesma resposta reprocessada (fila, retry) gera a mesma chave → o Italoc devolve o mesmo orçamento. */
export function idempotencyKey(ctx: ToolContext, tool: string, input: unknown): string {
  return createHash("sha256").update(JSON.stringify([ctx.conversationId, ctx.triggerMessageId, tool, input])).digest("hex");
}

const MAX_RESULT_CHARS = 12000;

function ok(data: unknown): ToolOutcome {
  const text = JSON.stringify(data);
  return { content: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…(resultado truncado)` : text, isError: false };
}

function fail(message: string): ToolOutcome {
  return { content: JSON.stringify({ erro: message, orientacao: "Não invente a informação. Diga que não conseguiu consultar agora e ofereça um atendente." }), isError: true };
}

/** Executa uma ferramenta. Nunca lança: erro vira tool_result com is_error, pra IA lidar. */
export async function executeTool(italoc: ItalocApi, ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolOutcome> {
  const schema = inputSchemas[name];
  if (!schema) return fail(`Ferramenta desconhecida: ${name}`);
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return { content: JSON.stringify({ erro: "Parâmetros inválidos", detalhes: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }), isError: true };
  }
  const input = parsed.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  const call = async (action: string, body: Record<string, unknown>) => {
    const result = await italoc.call(ctx.companyId, action, body);
    if (result.ok) return ok(result.data);
    // Erros de regra (cliente não cadastrado, orçamento de outro número...) não são falha de sistema.
    if (!result.retryable && result.code !== "internal_error" && !result.code.startsWith("http_")) {
      return { content: JSON.stringify({ erro: result.error, codigo: result.code }), isError: true };
    }
    return fail(result.error);
  };

  switch (name) {
    case "consultar_cliente":
      return call("context", { phone: ctx.phone });
    case "buscar_equipamento":
      return call("equipment-search", input.termo ? { query: input.termo } : {});
    case "consultar_disponibilidade":
      return call("availability", { ref: input.ref, startDate: input.data_inicio, endDate: input.data_fim, quantity: input.quantidade });
    case "listar_bairros_atendidos":
      return call("neighborhoods", {});
    case "calcular_orcamento":
      return call("price", pricingBody(input as z.infer<typeof pricingSchema>));
    case "criar_orcamento":
      return call("quote-create", {
        ...pricingBody(input as z.infer<typeof pricingSchema>),
        phone: ctx.phone,
        contactName: input.nome_contato ?? ctx.contactName,
        address: input.endereco,
        conversationId: ctx.conversationId,
        idempotencyKey: idempotencyKey(ctx, name, input),
      });
    case "consultar_orcamentos":
      return call("quotes", { phone: ctx.phone });
    case "registrar_aprovacao_orcamento":
      return call("quote-approval", { phone: ctx.phone, quoteNumber: input.numero_orcamento, conversationId: ctx.conversationId });
    case "consultar_locacoes":
      return call("rentals", { phone: ctx.phone });
    case "consultar_saldo":
      return call("balance", { phone: ctx.phone });
    case "gerar_pix":
      return call("pix", { phone: ctx.phone, rentalNumber: input.numero_locacao });
    case "registrar_interesse":
      return call("interest", { phone: ctx.phone, contactName: input.nome_contato ?? ctx.contactName, interest: input.resumo, conversationId: ctx.conversationId });
    case "transferir_para_atendente":
      // A troca de estado e o aviso ao escritório acontecem depois do turno
      // (services/reply.ts), junto com o envio da mensagem final.
      return { content: JSON.stringify({ ok: true, instrucao: "Transferência registrada. Avise o cliente que um atendente vai continuar por aqui." }), isError: false, handoffReason: input.motivo };
    default:
      return fail(`Ferramenta desconhecida: ${name}`);
  }
}
