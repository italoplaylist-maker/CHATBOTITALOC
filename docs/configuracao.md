# Configuração e deploy

## Variáveis de ambiente

Veja [`.env.example`](../.env.example). Todas são validadas na subida: faltando
ou inválida, o processo nem sobe, e o erro mostra só o **nome** da variável.
Segredo nenhum tem valor padrão nem vai para o Git.

| Variável | Para quê |
|---|---|
| `DATABASE_URL` | Postgres **próprio** do chatbot |
| `META_APP_SECRET` | só para número da Meta: valida a assinatura do webhook |
| `META_VERIFY_TOKEN` | só para número da Meta: token da verificação do webhook (você escolhe) |
| `META_GRAPH_VERSION` | versão da Graph API (padrão `v23.0`) |
| `CHANNEL_TOKEN_KEY` | 32 bytes base64, criptografa os tokens dos números |
| `ITALOC_BASE_URL` | URL interna do Italoc |
| `ITALOC_SHARED_SECRET` | igual a `CHATBOT_API_SECRET` do Italoc |
| `ANTHROPIC_API_KEY` | chave da API da Anthropic |
| `AI_MODEL`, `AI_EFFORT`, `AI_*` | modelo e limites da IA |
| `WORKER_CONCURRENCY` | respostas em paralelo (conversas diferentes) |

## Italoc

No Italoc (Coolify → Environment Variables):

```
CHATBOT_API_SECRET=<mesmo valor de ITALOC_SHARED_SECRET>
CHATBOT_SERVICE_URL=<URL interna deste serviço, ex.: http://chatbotitaloc:3000>
```

Sem `CHATBOT_API_SECRET`, a API interna do Italoc responde 404 e o painel
Atendimento mostra que a integração não está configurada. Libere o módulo
**Atendimento WhatsApp** para os usuários que vão atender (Usuários → módulos).

## Evolution API (o jeito mais simples)

Usa o servidor e a instância da Evolution que o Italoc já usa para os
lembretes. O número conectado pelo QR code em Configurações passa a ser
atendido pelo bot. Não precisa de app nem de token na Meta.

**Atenção:** a Evolution não é oficial (funciona como um WhatsApp Web). O
WhatsApp pode banir o número, principalmente com muito envio ou denúncia.
Prefira um número dedicado ao atendimento e, se o volume crescer, migre para
a Meta (seção abaixo), que funciona em paralelo.

1. Suba o chatbot no Coolify (seção **Coolify**). As variáveis `META_*` podem ficar vazias.
2. No terminal do container do chatbot:

```bash
EVOLUTION_API_KEY='<a mesma EVOLUTION_API_KEY do Italoc>' npm run channel:upsert -- \
  --provider evolution --company <id da empresa no Italoc> \
  --instance oscontrol-<8 primeiros caracteres do id da empresa> \
  --evolution-url <a mesma EVOLUTION_API_URL do Italoc> \
  --webhook-base https://<domínio do chatbot> --name "Nome da empresa"
```

   O comando gera um segredo novo para a URL do webhook (o banco guarda só o
   hash) e já configura o webhook na instância, com os eventos
   `MESSAGES_UPSERT` e `MESSAGES_UPDATE`. Se a Evolution recusar, ele mostra
   a URL uma única vez para você colar no painel da Evolution. Rodar de novo
   troca o segredo.

3. A instância usada pelo Italoc se chama `oscontrol-` seguido dos 8
   primeiros caracteres do id da empresa. O id não aparece em nenhuma tela;
   pegue no banco do Italoc (Coolify → banco do Italoc → Terminal):

```sql
SELECT id, name FROM "Company";
```

**Como o bot se comporta na Evolution**
- Não existe a janela de 24h: o atendente pode responder a qualquer momento. Modelo (template) não existe e é recusado.
- Grupos, status e canais são ignorados.
- Os lembretes que o Italoc manda pelo mesmo número não entram nas conversas.
- **Resposta digitada no próprio celular da empresa**, numa conversa que o bot está atendendo, aparece no painel como "Celular da empresa" e **tira a conversa do bot** (estado Humano), para a IA não responder por cima. Para devolver ao bot, use o painel. Conversa pessoal iniciada pelo celular não vira atendimento.

## Meta (WhatsApp Cloud API)

1. No app da Meta, em WhatsApp → Configuração, cadastre o webhook:
   - URL: `https://<seu-domínio-do-chatbot>/webhooks/whatsapp`
   - Token de verificação: o valor de `META_VERIFY_TOKEN`
   - Assine o campo **messages**.
2. Gere um token de acesso **permanente** (usuário do sistema do Business Manager) com `whatsapp_business_messaging`.
3. Cadastre o número (ligado à empresa do Italoc):

```bash
CHANNEL_ACCESS_TOKEN=<token> npm run channel:upsert -- \
  --company <id da empresa no Italoc> --phone-number-id <Phone number ID da Meta> \
  --name "Nome da empresa" --display "+55 37 3232-0000"
```

Em produção, rode o comando no terminal do container (Coolify → Terminal),
depois do primeiro deploy. Ele usa o código já compilado (`dist/`). Em
desenvolvimento, use `npm run channel:upsert:dev`. O token vai por variável
de ambiente, não por argumento. `--bot off` deixa o número só com
atendimento humano.

O id da empresa no Italoc não aparece em nenhuma tela. Pegue no banco do
Italoc (Coolify → banco do Italoc → Terminal):

```sql
SELECT id, name FROM "Company";
```

Janela de 24h: texto livre só vale até 24h depois da última mensagem do
cliente. Depois disso, só modelo aprovado na Meta (endpoint
`/admin/conversations/:id/template`).

## Coolify

- Novo recurso a partir deste repositório, **Dockerfile** (build pack Dockerfile), porta `3000`.
- Um Postgres próprio para o chatbot, cuja URL vai em `DATABASE_URL`.
- Domínio público **só** para `/webhooks/whatsapp` (a Meta precisa alcançar). `/admin/*` é protegido por HMAC e deve ser chamado pela rede interna do Italoc.
- Healthcheck já vem no Dockerfile (`GET /health`: 200 ok, 503 no desligamento ou sem banco).
- As migrations rodam sozinhas no start (`prisma migrate deploy`).
- Redeploy manda SIGTERM: o serviço para de pegar job novo, termina o que está em andamento e sai. Um job interrompido no meio volta para a fila sozinho (5 min).
- Várias réplicas funcionam (fila com `SKIP LOCKED`), mas uma réplica basta para o volume normal.
