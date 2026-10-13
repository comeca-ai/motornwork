# Modelo multicliente: política e despesa por webhook

O workflow importável está em `modelo-webhooks-politica-despesa-auditoria.json`. Ele recebe um arquivo por chamada, confirma o recebimento com HTTP 202 e envia o JSON completo ao `callbackUrl` do sistema transacional após a análise. O n8n não decide qual política está ativa nem mantém o cadastro das empresas neste modelo.

## Identidade e versões

- `clientId`: identificador estável e único da empresa, criado pelo sistema transacional. Use letras minúsculas, números, `_` e `-`, com 2 a 64 caracteres.
- `requestId`: identificador único da solicitação, criado pelo sistema transacional. Use-o para evitar processamento duplicado e vincular a resposta à transação original.
- `callbackUrl`: URL HTTPS pública do sistema transacional que recebe um POST com o JSON completo quando a análise termina.
- `policyVersion`: versão imutável atribuída pelo sistema transacional. Uma atualização produz outra versão; nunca edite retroativamente a versão usada em uma despesa anterior.
- O sistema transacional deve enviar à análise de despesa o `politicaJson` da versão aprovada e aplicável à data da despesa. O workflow confere a correspondência de `clientId` e `policyVersion`.

## Endpoints de produção

Workflow publicado em `https://primary-production-052d.up.railway.app/workflow/jWDW2X7ySTkz3hxE`. O endpoint de despesa foi testado em produção: HTTP 202 no recebimento e POST do resultado ao callback após a análise.

| Tarefa | Método | Caminho de produção |
| --- | --- | --- |
| Processar política | POST | `/webhook/modelo/v1/politicas/processar` |
| Analisar despesa | POST | `/webhook/modelo/v1/despesas/analisar` |

Envie `multipart/form-data` com exatamente um arquivo no campo `arquivo`, até **15 MB**. O limite padrão do webhook n8n é 16 MB; a instância pode ter outro limite configurado. Os exemplos usam HTTPS e não exigem header de autenticação nem campo de opt-in. Os endpoints ficam acessíveis publicamente após a publicação; limite abuso e custos na infraestrutura.

### Política

Campos: `clientId`, `requestId`, `policyVersion`, `action` (`create` ou `update`), `callbackUrl` e `arquivo` (PDF).

Exemplo de chamada (defina `CALLBACK_URL` com o endpoint HTTPS do seu sistema):

```bash
curl -X POST 'https://primary-production-052d.up.railway.app/webhook/modelo/v1/politicas/processar' \
  -F 'clientId=empresa_123' \
  -F 'requestId=politica-2026-001' \
  -F 'policyVersion=2026-10' \
  -F 'action=create' \
  -F "callbackUrl=$CALLBACK_URL" \
  -F 'arquivo=@politica.pdf;type=application/pdf'
```

Resposta inicial: HTTP 202 com `status=recebido`, `clientId`, `requestId`, `recebidoEm` e `sha256Arquivo`. O callback recebe `status=processado_aguarda_revisao`, `politicaJson` reutilizável, extração completa (regras, categorias, evidências, pendências e resumo), medições e auditoria. **O sistema transacional deve revisar e ativar** a nova versão antes de usá-la para decisões.

### Despesa

Campos: `clientId`, `requestId`, `policyVersion`, `callbackUrl`, `politicaJson` (JSON da versão aprovada, serializado como texto) e `arquivo` (PDF, JPG, PNG ou WebP).

Exemplo com o catálogo já aprovado salvo em `politica-aprovada.json`:

```bash
curl -X POST 'https://primary-production-052d.up.railway.app/webhook/modelo/v1/despesas/analisar' \
  -F 'clientId=empresa_123' \
  -F 'requestId=despesa-2026-045' \
  -F 'policyVersion=2026-10' \
  -F "callbackUrl=$CALLBACK_URL" \
  -F "politicaJson=$(cat politica-aprovada.json)" \
  -F 'arquivo=@nota.jpg;type=image/jpeg'
```

Resposta inicial: HTTP 202 com confirmação, IDs, horário e hash do arquivo. O callback recebe os dados da nota e itens disponíveis, texto OCR, evidências, checagens V1–V8, confronto com a política, parecer, custo e tempo por bloco, trilha com horários em ISO 8601 UTC, `sha256` do arquivo e `sha256Auditoria`. O valor de `status` vem do parecer; a aprovação financeira final continua humana.

No instante do recebimento pelo sistema transacional, grave o arquivo original sem alterações, o horário de chegada e o identificador da origem. Depois associe o `sha256` retornado pelo motor. Guarde a resposta JSON **integral**, incluindo todos os campos e itens lidos, texto visível, OCR independente, evidências, verificações, parecer, custos, horários e hashes. O JSON não duplica o PDF em base64. O opt-in informado pelo cliente autoriza o tratamento solicitado; controle acesso e retenção por empresa conforme o acordo aplicável.

## Setup de uma empresa

1. Crie um `clientId` único no sistema transacional.
2. Envie a primeira política com `action=create`; guarde o PDF, o hash e a resposta.
3. Após a revisão das regras e da vigência, marque a versão como aprovada no sistema transacional.
4. Para cada despesa, envie o comprovante e o `politicaJson` da versão aprovada aplicável.
5. Para atualizar a política, envie outro PDF com `action=update` e uma nova `policyVersion`. Preserve as versões anteriores para reproduzir pareceres já emitidos.

## Pontos de operação

- A confirmação 202 e o callback da despesa foram testados no endpoint de produção com um receptor de teste. A integração com o sistema transacional do cliente depende da URL de callback desse sistema.
- O modelo confirma o recebimento com HTTP 202 e continua a execução até fazer POST do resultado em `callbackUrl`. O receptor deve devolver status 2xx, persistir o corpo integral e tratar chamadas repetidas por `(clientId, requestId)`.
- A confirmação 202 atesta o recebimento e o hash. Falhas no processamento posterior precisam ser acompanhadas nas execuções do n8n; o modelo ainda não envia callback de erro nem faz nova tentativa de entrega.
- O sistema transacional deve aplicar unicidade em `(clientId, requestId)` e em `(clientId, policyVersion)`, controlar acesso por empresa e guardar a resposta integral.
- Os hashes identificam o arquivo recebido e o objeto de auditoria retornado. Eles não substituem assinatura digital nem armazenamento imutável.
