# Follow-up (desenho — ainda não ligado)

Mensagem ativa (a empresa escreve primeiro) tem regra própria na Meta e risco
de spam, por isso ficou desenhada mas **não ligada**:

- **Só por modelo aprovado.** Fora da janela de 24h, a Meta só aceita template. O envio já existe (`sendOutboundTemplate`, `/admin/conversations/:id/template`).
- **Opt-out respeitado.** "PARAR"/"SAIR" marca `Conversation.optOut`, e o envio de template recusa contato com opt-out.
- **Gatilhos** (quando ligar): orçamento `SENT` sem resposta há N dias; oportunidade parada em Negociação. A origem é o Italoc (CRM), e o chatbot só envia.
- **Limites** a configurar por empresa: no máximo 1 follow-up por oportunidade e por intervalo, só em horário comercial (mesma lição do lembrete de vencimento do Italoc, que precisou de janela a partir das 08:00) e nunca para quem já está em atendimento humano.
- **Execução:** job `followup.send` na mesma fila, com `dedupeKey` por oportunidade e janela, para nunca mandar em dobro.
