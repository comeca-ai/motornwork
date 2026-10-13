# motornwork

Arquivo versionado dos fluxos de política, OCR e consistência de despesas, com um gateway pronto para Cloudflare Workers.

## O que roda onde

| Componente | Estado | Função |
| --- | --- | --- |
| `src/index.js` | Pronto para build/deploy | Recebe os dois POSTs, valida tamanho e campos, encaminha o multipart ao n8n e repassa o HTTP 202. |
| `n8n/workflows/*.json` | Exportações importáveis | Fluxos de leitura de política, OCR, validação e modelo unificado. Exigem vincular credenciais OpenAI após importação. |
| `n8n/fragments/*.json` | Histórico e componentes | Versões anteriores e receptor de callback usado somente em testes. |
| Execução nativa de OCR/IA no Worker | Não implementada | Os arquivos n8n usam nós, expressões e estado próprios do n8n; o Worker não executa esses JSONs. |

**O gateway não substitui o motor atual.** Após publicar este Worker, OCR, categorização, consistência, política e callback continuam no n8n. O gateway oferece um endereço Cloudflare para entrada sem alterar o ambiente n8n. Uma migração nativa requer implementar e testar novamente essas etapas; veja [plano de migração](docs/migracao-nativa.md).

## Estrutura

- `n8n/manifest.json`: inventário e SHA-256 dos 11 JSONs preparados para este repositório.
- `n8n/workflows/`: sete workflows principais.
- `n8n/fragments/`: quatro backups, componentes e testes históricos.
- `docs/contrato-webhooks.md`: contrato HTTP, identidade por empresa, versionamento e persistência.
- `src/index.js`: gateway Cloudflare.
- `test/gateway.test.js`: verificações locais do encaminhamento e da resposta.

Os JSONs foram copiados com `active=false`, sem credenciais n8n, IDs de workflow, metadados de instância ou dados fixados. Os IDs dos nós e suas conexões foram preservados. A importação de um JSON **não ativa** gatilhos; associe credenciais antes de usar um fluxo importado. Os JSONs publicados no n8n não foram alterados por esta preparação.

## Subir o gateway no Cloudflare Worker

Pré-requisitos: Node.js e npm, uma conta Cloudflare com Workers habilitado, acesso de deploy e o n8n já publicado em `https://primary-production-052d.up.railway.app`.

```bash
npm install
npm test
npm run build
npx wrangler login
npm run deploy
```

`npm run build` usa `wrangler deploy --dry-run` e não publica. O `wrangler.jsonc` já contém `name`, `main`, `compatibility_date` e `N8N_BASE_URL`. Ao fazer deploy, Wrangler usará a conta Cloudflare autenticada e fornecerá a URL `*.workers.dev`. Nenhum segredo é exigido pelo gateway atual porque os webhooks n8n foram configurados sem autenticação. Se o n8n mudar de endereço, atualize somente `N8N_BASE_URL` no `wrangler.jsonc` e faça novo deploy. O endpoint `GET /health` confirma que o Worker responde; não atesta disponibilidade do n8n.

O Worker aceita arquivo até 15 MB e corpo multipart até 16 MB. Ele exige `clientId`, `requestId`, `policyVersion`, `callbackUrl` HTTPS e `arquivo`. Política exige PDF e `action=create|update`; despesa exige `politicaJson`. O Worker devolve o status e o corpo do n8n, inclusive a confirmação `HTTP 202`; o resultado completo é enviado **pelo n8n** ao `callbackUrl` informado. Não há autenticação nem campo de opt-in na chamada. O código não cria banco nem grava os documentos: o sistema transacional precisa preservar o arquivo original e persistir o callback integral.

### Exemplo: política

Defina a URL de retorno do seu sistema e a URL informada no deploy:

```bash
export MOTOR_URL='https://motornwork-gateway.SUA-CONTA.workers.dev'
export CALLBACK_URL='https://seu-sistema.example.com/webhooks/analises'
curl -i -X POST "$MOTOR_URL/webhook/modelo/v1/politicas/processar" \
  -F 'clientId=empresa_123' \
  -F 'requestId=politica-2026-001' \
  -F 'policyVersion=2026-10' \
  -F 'action=create' \
  -F "callbackUrl=$CALLBACK_URL" \
  -F 'arquivo=@politica.pdf;type=application/pdf'
```

A confirmação inicial é `202` com `status=recebido`, `requestId`, horário e hash. O callback traz `politicaJson`, todas as regras e categorias, evidências, medições e auditoria. Revise e aprove a versão no sistema transacional antes de usá-la.

### Exemplo: despesa

Use `politica-aprovada.json` com o `politicaJson` recebido e revisado na etapa anterior:

```bash
curl -i -X POST "$MOTOR_URL/webhook/modelo/v1/despesas/analisar" \
  -F 'clientId=empresa_123' \
  -F 'requestId=despesa-2026-001' \
  -F 'policyVersion=2026-10' \
  -F "callbackUrl=$CALLBACK_URL" \
  -F "politicaJson=$(cat politica-aprovada.json)" \
  -F 'arquivo=@nota.jpg;type=image/jpeg'
```

Guarde o JSON completo do callback por `(clientId, requestId)`, incluindo todos os campos lidos, OCR, itens, evidências, verificações, parecer, horários, custos e hashes. Uma nova política cria nova `policyVersion`; preserve as versões anteriores para reproduzir decisões passadas.

## Verificação e limites

- `npm test`: testa encaminhamento do multipart, resposta 202, validação do callback e rota de saúde.
- `npm run build`: empacota com Wrangler sem publicar. Nesta máquina, o build local não pôde ser concluído porque o macOS encerrou o binário nativo do `esbuild` instalado pelo npm (`SIGKILL`, arquivo marcado com quarentena). Os testes Node e a checagem de sintaxe passaram; execute o dry run em um ambiente em que o Wrangler possa iniciar normalmente antes do deploy.
- O fluxo de despesa foi exercitado previamente no n8n de produção: confirmou `202` e entregou o JSON completo a um receptor de teste. A rota de política está publicada no n8n, mas o teste com PDF real no callback do sistema transacional continua pendente.
- Um `202` confirma o recebimento e o hash, não a conclusão da análise. O callback de teste foi entregue com sucesso; a entrega ao sistema transacional do cliente depende de sua URL e disponibilidade.
- O gateway mantém o limite de 15 MB aplicado pelo n8n. O limite de corpo aceito na borda Cloudflare também depende do plano da conta.
- O Worker ainda não oferece filas, tentativas de callback, banco, armazenamento ou isolamento de clientes. Essas responsabilidades permanecem no n8n e no sistema transacional até uma migração nativa planejada.

## Fontes técnicas

- [Configuração Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Build sem deploy](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Request API dos Workers](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Webhooks n8n](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
