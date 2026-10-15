# Autenticação e retorno — configuração publicada

Autenticação publicada no Worker e no n8n. Retorno externo é opcional e permanece sem destino configurado; R2/D1 e consulta funcionam sem ele. Veja [guia completo](GUIA-INTEGRACAO-IA.md).

## Entrada

POST multipart nas rotas `/webhook/modelo/v1/politicas/processar` e
`/webhook/modelo/v1/despesas/analisar` com `Authorization: Bearer <integrationToken>`.
Um token autentica o sistema transacional; ele controla os usuários e empresas.
`clientId` é texto decimal de 100 a 1000, sem zeros à esquerda.
O Worker envia ao n8n somente a credencial interna `X-Motor-Secret`.
Configure Header Auth nos DOIS webhooks do n8n e publique.
A API key administrativa do n8n não substitui essa credencial.

Secrets do Worker: `INTEGRATION_TOKEN_SHA256` e `N8N_WEBHOOK_SECRET`.
Não publicar o código antes de configurar os secrets e coordenar a proteção no n8n.
Ausência de configuração bloqueia novas entradas com 503.

## Retorno ao sistema

Configure `CLIENT_CALLBACK_URL` com a URL HTTPS exata do receptor do sistema.
Opcionalmente configure o secret `CLIENT_CALLBACK_TOKEN`: enviado como Bearer.
O destino é fixado no ambiente; `callbackUrl` pode ser omitida na chamada.
Se informada, deve corresponder exatamente ao destino configurado.
O Worker mantém seu callback interno com o n8n e armazena o resultado antes
 de entregar o JSON integral recebido ao sistema, incluindo `medicao` e `auditoria`.
Não há filtros de campos nem preenchimento de nulls.

O receptor deve gravar o JSON de forma durável e responder 2xx em até 10 segundos.
O header `Idempotency-Key` contém o ID da solicitação do Worker: deduplicar
por esse valor, pois a entrega pode se repetir após timeout ou falha de rede.
Redirecionamentos não são seguidos. Não confundir entrega com aprovação da despesa.

O recibo continua HTTP 202 com `resultUrl` e `resultToken`.
GET nessa URL, com `Authorization: Bearer <resultToken>`, continua disponível.
`state=completed` indica análise armazenada; `delivery.state=delivered` indica
aceitação HTTP pelo receptor. `failed` indica falha de entrega, preservando análise.
`delivery` informa tentativas, horários e status HTTP, sem corpo da resposta ou segredo.

Para repetir SOMENTE a entrega após falha:
`POST <resultUrl>/reenviar`, com o mesmo resultToken.
Retorna 200 se entregue, 502 se continua pendente; 409 sem resultado/destino.
Duplicata de callback do n8n também tenta novamente entrega pendente.
Não existe agendador de novas tentativas nesta versão: o sistema deve chamar
`/reenviar` em caso de falha. Não reenviar a despesa nem repetir OCR.
Uma entrega já confirmada não é disparada novamente.
Solicitações anteriores sem destino configurado conservam somente a consulta.

## Verificação

Testes locais: entrada autenticada, faixa clientId, preservação do arquivo,
callback interno, identidade, deduplicação, consulta protegida, entrega integral,
falha de receptor e recuperação sem nova análise. Integração real depende da
URL de destino e das credenciais em produção. Não confundir testes simulados
com validação ponta a ponta nos serviços reais.
