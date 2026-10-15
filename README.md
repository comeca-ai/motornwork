# motornwork

Motor de política e despesas: Cloudflare Worker autenticado, arquivo e JSON integral em R2 privado, índice e relatórios no D1, processamento no n8n Cloud.

## Documentação para implementar a integração

**[Guia completo para IA, backend e frontend](docs/GUIA-INTEGRACAO-IA.md)** — cadastro de empresa, política inicial/atualização, despesa, contratos, autenticação, polling, arquivos, relatórios de custo e tempo, telas, erros e testes.

- [Cliente JavaScript para backend](examples/motor-client.mjs).
- [Contrato HTTP](docs/contrato-webhooks.md).
- [Histórico de migração n8n Cloud](docs/migracao-n8n-cloud.md).
- [Autenticação e callback externo opcional](docs/autenticacao-retorno.md).

## Produção

Base: `https://motornwork.jhonata-emerick.workers.dev`.
Entradas e `/api/v1/*` exigem `Authorization: Bearer <integrationToken>` do backend.
clientId de `100` a `1000`, como texto sem zeros à esquerda.

| Método | Rota | Finalidade |
|---|---|---|
| POST | `/webhook/modelo/v1/politicas/processar` | PDF → regras e catálogo |
| POST | `/webhook/modelo/v1/despesas/analisar` | Comprovante + catálogo aprovado → análise |
| GET | `/api/v1/solicitacoes?clientId=100` | Lista e filtros por empresa |
| GET | `/api/v1/solicitacoes/{id}?clientId=100` | JSON integral |
| GET | `/api/v1/solicitacoes/{id}/arquivo?clientId=100` | Arquivo original |
| GET | `/api/v1/solicitacoes/{id}/resultado-original?clientId=100` | Bytes do callback nas novas análises |
| GET | `/api/v1/solicitacoes/{id}/medicao?clientId=100` | Custo e tempo individual |
| GET | `/api/v1/relatorios/processamento?clientId=100` | Agregados e etapas |
| POST | `/api/v1/indice/reconstruir` | Administração: reconstruir D1 a partir do R2 |
| GET | `/resultados/v1/{id}` | Consulta com `resultToken` exclusivo do recibo |
| GET | `/health` | Worker respondendo; não atesta saúde das dependências |

O HTTP 202 confirma recebimento. Resultado final chega ao callback interno do Worker e fica guardado. Não é necessário webhook externo. O estado `completed` não equivale a despesa aprovada; leia o parecer.

## Componentes

- `src/index.js`: entrada, autenticação, R2, callback e APIs.
- `src/catalog.js`: índice D1, filtros, paginação e relatórios.
- `migrations/0001_requests.sql`: tabela e índices, sem remoção de dados.
- `test/`: testes de contrato, autenticação, callbacks, SQLite e isolamento de consulta.
- `n8n/workflows/`: templates exportados; importar exige vincular credenciais e publicar. Não são cópia automática do estado vivo do n8n.
- `n8n/fragments/`: históricos e componentes de teste.

A IA/OCR continua executando no n8n; Worker não executa o JSON de workflow nativamente.

## Configuração

Bindings: R2 `RESULTS_BUCKET=motornwork-results`; D1 `INDEX_DB=motornwork-index`.
`N8N_BASE_URL=https://reembolsa.app.n8n.cloud`.
Secrets: `INTEGRATION_TOKEN_SHA256`, `N8N_WEBHOOK_SECRET`.
No n8n, ambos os webhooks usam Header Auth `X-Motor-Secret`.
Opcional: `CLIENT_CALLBACK_URL` e secret `CLIENT_CALLBACK_TOKEN` para push externo.

```bash
npm ci
npm test
npm run build
# Em outro ambiente, criar recursos e configurar os IDs reais no wrangler.jsonc.
# Schema idempotente; em produção foi aplicado pelo Console D1:
npx wrangler d1 execute motornwork-index --remote --file migrations/0001_requests.sql
npm run deploy
```

O deploy de produção é feito por Cloudflare Builds ligado ao branch main do GitHub. Secrets não vão no repositório. A migração de tabela é separada do deploy de código. IDs no wrangler pertencem à conta atual; não reutilize em outra conta.

## Limites e operação

Arquivo até 15 MiB, multipart até 16 MiB. O token central é só do backend: o sistema transacional autoriza cada usuário/empresa.
R2 preserva resultado completo; D1 é índice reconstruível e pode atrasar se falhar. Não há fila/retry automático do OCR nem callback de erro para todas as falhas após o 202.
Custos são estimativas de IA em USD; infraestrutura e impostos não incluídos. Políticas devem ser revistas e aprovadas no sistema transacional antes de enviar despesas.

Veja o guia completo para exemplos de chamadas, campos e retorno.
