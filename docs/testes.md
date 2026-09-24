# Testes

```bash
# Postgres local com um banco de TESTE (o setup recusa URL sem "chatbot_test")
createdb chatbot_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/chatbot_test npm test
```

O setup zera o schema do banco de teste e aplica as migrations. A Meta, o
Italoc e a IA são dublês (`test/helpers.ts`). O banco é real, porque a
idempotência, a fila e a concorrência dependem do Postgres.

| # | Cenário | Teste |
|---|---|---|
| 1 | Cliente existente | `cliente existente: consulta locações com o telefone da conversa…` |
| 2 | Cliente desconhecido | `cliente desconhecido vira lead…` |
| 3–6 | Equipamento, inexistente, disponibilidade, preço | `equipamento, inexistente, disponibilidade e preço…` |
| 7 | Orçamento | `orçamento: criado com chave de idempotência estável…` |
| 8 | Continuidade | `continuidade: 'e por 10 dias?'…` |
| 9 | Mensagem duplicada | `mensagem duplicada (mesmo wamid)…` |
| 10 | Webhook duplicado | `webhook duplicado inteiro…` |
| 11 | Falha da IA | `falha da IA: cliente recebe a mensagem fixa…` |
| 12 | Falha do Italoc | `falha do Italoc: a IA recebe erro explícito…` |
| 13 | Transferência para humano | `transferência: IA chama transferir_para_atendente…` |
| 14 | Humano assumindo | `humano assumindo: a IA fica em silêncio…` (+ corrida IA × atendente) |
| 15 | Retorno ao bot | `retorno ao bot…` |
| 16–17 | Prompt injection / outro cliente | `prompt injection / dados de outro cliente…` |
| 18 | Outra empresa | `outra empresa…` |
| 19 | Timeout | `timeout ao consultar o Italoc…` |
| 20 | Mensagens simultâneas | `mensagens simultâneas: um job pendente por conversa…` |

Também são cobertos: assinatura inválida, verificação do webhook, número
desconhecido, ordem de status, janela de 24h, job preso, reenvio, erro que
esgota as tentativas, token fora da API e mascaramento de log.

O lado Italoc (dono do telefone, orçamento de outro contato, Pix de outra
locação, assinatura, replay) tem testes no próprio Italoc
(`lib/service-signature.test.ts`, `types/*.test.ts`) e foi validado ponta a
ponta com os dois serviços rodando.

**Não coberto automaticamente:** a qualidade das respostas do modelo real. Os
testes usam uma IA roteirizada. Antes de ligar em produção, faça uma rodada
manual com um número de teste da Meta.
