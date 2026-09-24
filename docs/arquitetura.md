# Arquitetura

## Responsabilidades

| CHATBOTITALOC (este serviço) | Italoc |
|---|---|
| Webhook da Meta, envio de mensagens, status de entrega | Clientes, equipamentos, preços, frete, disponibilidade |
| Conversas, histórico, contexto curto | Orçamentos, locações, saldo, Pix |
| IA + execução de ferramentas | Regras comerciais (a conta de preço é a mesma dos formulários, `types/pricing.ts`) |
| Estados BOT/humano, fila, retries, logs técnicos | CRM (oportunidades) e notificações do escritório |

O chatbot nunca guarda cópia de dado comercial. Ele guarda só referências
(`companyId` do Italoc, id/nome do atendente).

## Fluxo de uma mensagem

1. `POST /webhooks/whatsapp`: valida `X-Hub-Signature-256` sobre o corpo cru (`META_APP_SECRET`).
2. Grava o corpo em `WebhookEvent` (auditoria, apagado depois de `WEBHOOK_RETENTION_DAYS`).
3. Para cada mensagem, acha o número (`Channel.phoneNumberId`, que dá a empresa), cria/acha a conversa (`channelId + waId`) e grava a mensagem com `waMessageId` **único**. Se a mensagem já existe, é duplicada e é ignorada.
4. Conversa em modo `BOT`: enfileira `conversation.reply` com `dedupeKey = reply:<conversa>`, então fica no máximo um job pendente por conversa.
5. Responde 200 logo em seguida. A IA nunca roda dentro do webhook.
6. O worker pega o job (`FOR UPDATE SKIP LOCKED`, nunca dois da mesma conversa ao mesmo tempo) e responde **todas** as mensagens ainda não respondidas de uma vez.
7. A IA roda o loop de ferramentas. A resposta final é gravada junto com a marcação das mensagens respondidas, na mesma transação, e só depois é enviada. Se o envio falhar, a mensagem fica `FAILED` e entra na fila de reenvio sem chamar a IA de novo.

## Estados da conversa

| Estado | Quem responde | Como entra |
|---|---|---|
| `BOT` | IA | padrão; atendente "devolve ao bot"; mensagem nova numa conversa finalizada |
| `AWAITING_AGENT` | ninguém (aguarda) | IA chamou `transferir_para_atendente`, falha da IA, recusa |
| `HUMAN` | atendente | atendente clica em Assumir ou responde pelo painel |
| `CLOSED` | ninguém | atendente finaliza |

Toda troca de estado fica em `Handoff`: quem, quando e por quê. Se o atendente
assumir enquanto a IA ainda está pensando, a resposta da IA é descartada.

## IA

- Modelo configurável (`AI_MODEL`), padrão **`claude-haiku-4-5`** (o mais barato), com raciocínio por orçamento fixo (2048 tokens). Para respostas mais cuidadosas, `AI_MODEL=claude-opus-5`: aí valem o raciocínio adaptativo, o `AI_EFFORT` e o refazer da recusa no mesmo request pelo modelo que a Anthropic recomenda (`fallbacks: "default"`). Cada família recebe só os parâmetros que aceita (`modelRequestOptions`, `src/ai/agent.ts`).
- Cache do prompt: no Haiku 4.5, o cache só entra a partir de 4096 tokens de prefixo. Se o prompt fixo + ferramentas ficar abaixo disso, cada resposta paga o prompt inteiro. O custo real aparece em `AiRun` (tokens de entrada, saída e lidos do cache).
- O prompt fixo e as ferramentas ficam em cache. O contexto da conversa (data, empresa, cliente identificado) vai depois do ponto de cache.
- **Nunca inventa** preço, estoque, prazo ou financeiro: tudo vem das ferramentas. Se uma ferramenta falhar, a IA recebe um erro explícito com a orientação de não inventar.
- Se a API da IA cair (depois dos retries do SDK), o cliente recebe uma mensagem fixa e a conversa vai para atendente (`AWAITING_AGENT`, com aviso no Italoc).

## Níveis de ferramenta

| Nível | Ferramentas |
|---|---|
| Leitura (automática) | consultar_cliente, buscar_equipamento, consultar_disponibilidade, listar_bairros_atendidos, calcular_orcamento, consultar_orcamentos, consultar_locacoes, consultar_saldo |
| Criação controlada | registrar_interesse (oportunidade), criar_orcamento (preço calculado pelo Italoc, idempotente), registrar_aprovacao_orcamento (só avisa o escritório), gerar_pix (do saldo existente; reaproveita cobrança aberta), transferir_para_atendente |
| Sensível | **não existe como ferramenta**: dar baixa, cancelar, alterar contrato, preço, desconto, excluir, mexer no financeiro |

Fluxo seguro de venda: orçamento → cliente aprova (`registrar_aprovacao_orcamento`)
→ aguardando confirmação → **atendente** confirma e converte em locação no Italoc.

## Segurança

- **Nenhuma ferramenta recebe telefone, id de cliente ou de empresa.** Esses dados vêm do contexto da conversa: o número que o WhatsApp informou e o número da empresa que recebeu a mensagem. O Italoc resolve o cliente pelo telefone e só mostra dados dele. Um prompt injection não consegue sequer pedir os dados de outra pessoa.
- Chamadas CHATBOT↔ITALOC são assinadas com HMAC-SHA256 (`v1`, timestamp com tolerância de 5 min, método, caminho, empresa e corpo). Uma chamada assinada não serve para outra rota nem para outra empresa. A API `/admin/*` também exige essa assinatura, e conversa de outra empresa responde 404.
- Tokens da Meta ficam criptografados no banco (AES-256-GCM, `CHANNEL_TOKEN_KEY`) e nunca saem pela API.
- O log mascara campos de segredo em qualquer profundidade e não registra o texto das mensagens.
- Multiempresa: cada número (`Channel`) pertence a uma empresa, e o mesmo telefone de cliente vira conversas separadas por empresa.

## Banco (Prisma)

`Channel`, `Conversation`, `Message`, `WebhookEvent`, `Job`, `AiRun`, `ToolCall`, `Handoff`. As migrations ficam em `prisma/migrations` e são aplicadas no boot (`prisma migrate deploy`).
