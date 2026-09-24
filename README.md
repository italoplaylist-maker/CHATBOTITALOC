# CHATBOTITALOC

Atendimento automático por WhatsApp (Evolution API ou Meta Cloud API + Claude) para empresas
que usam o **Italoc**. É um serviço separado: o Italoc continua sendo a fonte
da verdade (clientes, equipamentos, preços, disponibilidade, orçamentos,
locações, financeiro, Pix). Este serviço guarda só as conversas e consulta
tudo o mais pela API interna autenticada do Italoc, sem acessar o banco dele.

```
Cliente (WhatsApp) ──► Evolution ──► POST /webhooks/evolution/<segredo> ─┐
                  └─► Meta ──────► POST /webhooks/whatsapp ─────────────┴► grava + fila ──► worker
                                                                           │
                                     resposta ◄── Evolution/Meta ◄── IA (Claude) ◄───┤ ferramentas
                                                                           ▼
                                                  Italoc /api/internal/chatbot/* (HMAC)
Painel do Italoc (/atendimento) ──► /admin/* deste serviço (HMAC, só servidor→servidor)
```

- **Stack:** Node 22 + TypeScript, Hono, Prisma + PostgreSQL (banco próprio), fila no próprio Postgres (sem Redis), SDK oficial da Anthropic.
- **Rodar local:** `cp .env.example .env` (preencha), `npx prisma migrate deploy`, `npm run dev`.
- **Testes:** `npm test` (Postgres local com o banco `chatbot_test`; ver [docs/testes.md](docs/testes.md)).

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/arquitetura.md](docs/arquitetura.md) | Fluxo, estados da conversa, fila, idempotência, segurança, limites da IA |
| [docs/configuracao.md](docs/configuracao.md) | Variáveis de ambiente, Meta, Italoc, cadastro de número, Coolify |
| [docs/testes.md](docs/testes.md) | Como rodar os testes e os 20 cenários cobertos |
| [docs/nova-ferramenta.md](docs/nova-ferramenta.md) | Como adicionar uma ferramenta (tool) nova |
| [docs/follow-up.md](docs/follow-up.md) | Desenho do follow-up (ainda não ligado) |
