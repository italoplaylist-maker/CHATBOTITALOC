# Como adicionar uma ferramenta

1. **Italoc primeiro.** A regra de negócio mora lá. Crie a função em
   `server/services/chatbot-api.ts`, o schema em `schemas/chatbot.ts` e
   registre a ação no mapa `handlers` de `app/api/internal/chatbot/[action]/route.ts`.
   Dado de cliente **sempre** resolvido pelo `phone` recebido, nunca por um id vindo de fora.
2. **Definição** em `src/ai/tools.ts` → `TOOL_DEFINITIONS`: nome em português,
   descrição clara de quando usar, `strict: true`, `additionalProperties: false`,
   todos os campos em `required` (opcional = tipo com `null`).
   **Não** crie campo de telefone, cliente ou empresa.
3. **Validação local** em `inputSchemas` (zod) e o `case` em `executeTool`,
   traduzindo os campos para o contrato do Italoc. Telefone e empresa vêm do `ctx`.
4. Escrita? Gere a chave com `idempotencyKey(ctx, name, input)` e faça o Italoc
   respeitar a chave.
5. Ação sensível (baixa, cancelamento, preço, desconto, exclusão, financeiro)
   **não vira ferramenta**: vira transferência para atendente.
6. Teste em `test/scenarios.test.ts`: a IA roteirizada chama a ferramenta, e o
   teste confere o corpo que chega no Italoc dublê.
7. Se mudar o comportamento esperado, ajuste o `SYSTEM_PROMPT` (`src/ai/prompt.ts`).
