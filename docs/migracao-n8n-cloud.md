# Produção n8n Cloud — 14/10/2026

- Worker principal: `https://motornwork.jhonata-emerick.workers.dev`.
- Destino: `https://reembolsa.app.n8n.cloud`.
- Workflow publicado: `bruCI1v23KBH1yP3`.
- Política: `POST /webhook/modelo/v1/politicas/processar`.
- Despesa: `POST /webhook/modelo/v1/despesas/analisar`.
- O Worker gera o callback e devolve `resultUrl` e `resultToken` no HTTP 202.
- Consultar `resultUrl` com `Authorization: Bearer {resultToken}` até HTTP 200.

Política e despesa foram executadas no n8n Cloud com entrega do callback. Corrigido o reconhecimento do nome por extenso de NFC-e no cruzamento com o modelo 65 da chave. Dados de OCR insuficientes continuam exigindo revisão.

A configuração Wrangler usa o nome do Worker principal. O Worker legado `motornwork-gateway` é um recurso separado e não faz parte desta alteração.

## Recuperação

Para reverter somente o destino, restaure a variável N8N_BASE_URL anterior no painel Cloudflare, após confirmar a disponibilidade do ambiente anterior. A mudança de destino não exclui os arquivos e resultados já guardados no R2. Versões anteriores do workflow permanecem no histórico do n8n.
