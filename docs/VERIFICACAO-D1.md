# Verificação da implantação R2 + D1

Data: 15/10/2026 UTC (14/10/2026 BRT).

- Worker: `motornwork.jhonata-emerick.workers.dev`.
- Código D1 publicado: commit `0186b44`.
- D1 criado: `motornwork-index`, binding `INDEX_DB`.
- Schema de `migrations/0001_requests.sql` aplicado pelo Console D1 com sucesso.
- Reconstrução via API de produção: 2 registros indexados, nenhuma falha, nenhuma página restante.
- Os dois registros são testes históricos com IDs de empresa anteriores à faixa numérica. Foram preservados sem reatribuição a empresas atuais.
- Conferência SQL de custo/tempo existente: 0.012274 USD / 17469 ms / 23136 ms ponta a ponta; 0.012552 USD / 12971 ms / 18641 ms ponta a ponta.
- GET listagem com clientId=100 e token central: HTTP 200, lista vazia (nenhuma despesa foi artificialmente atribuída a essa empresa).
- GET relatório clientId=100: HTTP 200, zero solicitações e métricas desconhecidas null.
- Sem token: HTTP 401; limit inválido: HTTP 400; ID inexistente: HTTP 404.
- 31 testes locais passaram. Os testes de SQL usam SQLite real em memória com o schema de migração. O teste do ciclo entrada/callback/R2/D1 usa armazenamento e n8n simulados; não equivale a um novo OCR em produção.
- Não foi repetida análise de documento nem consumida nova chamada de IA para esta implantação.

Limite de verificação: o próximo envio real com um clientId numérico deve validar OCR → callback → indexação com dados da empresa. Consulta, reconstrução do índice e autenticação foram verificadas nos serviços reais. Callback externo não está configurado e não é necessário para R2/D1.

Rollback: voltar ao commit anterior remove as novas APIs, sem excluir R2 nem tabela D1. Não executar DROP TABLE ou apagar o bucket como rollback. A reconstrução do índice é idempotente e não dispara OCR.
