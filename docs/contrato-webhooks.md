# Contrato HTTP vigente

O contrato detalhado está no **[Guia de integração para IA, backend e frontend](GUIA-INTEGRACAO-IA.md)**.

Base de produção: `https://motornwork.jhonata-emerick.workers.dev`.
Entradas e consultas `/api/v1/*` exigem `Authorization: Bearer <integrationToken>`.
Faixa de clientId: strings `100`–`1000`.

## Entradas multipart

- Política: POST `/webhook/modelo/v1/politicas/processar`, com `clientId`, `requestId`, `policyVersion`, `action=create|update` e `arquivo` PDF.
- Despesa: POST `/webhook/modelo/v1/despesas/analisar`, com `clientId`, `requestId`, `policyVersion`, `politicaJson` serializado e `arquivo`; `vendedorId` opcional.
- Exatamente um arquivo, até 15 MiB; requisição até 16 MiB. Sem campo de opt-in.
- Não informar callbackUrl no modo padrão: Worker recebe e armazena o retorno no R2.
- HTTP 202 retorna `id`, IDs de negócio, hash, horário, `resultUrl` e `resultToken`.
- GET em resultUrl usa Bearer resultToken; consultas centrais usam token da integração.

## n8n direto (interno)

Base `https://reembolsa.app.n8n.cloud`, mesmos caminhos de webhook, header `X-Motor-Secret` e callbackUrl HTTPS obrigatório. Chamar diretamente não passa pelo armazenamento/índice/deduplicação do Worker e não devolve resultUrl/resultToken. Integrações novas devem usar o Worker.

Os endereços Railway e motornwork-gateway das versões históricas deste documento não são a integração principal atual. Os exemplos sem autenticação foram substituídos pelo guia vigente.
