# Migração futura para execução nativa em Cloudflare

Os JSONs n8n são definições para o executor n8n. Cloudflare Workers não contém esse executor nem interpreta automaticamente seus nós. Este repositório oferece um gateway funcional; uma migração integral deve ser um projeto separado, validado com a mesma política e um conjunto de comprovantes de referência.

| Etapa atual | Candidato Cloudflare | Trabalho necessário |
| --- | --- | --- |
| Entrada de PDF/imagem e hash | Worker + R2 | Receber arquivo, calcular SHA-256, armazenar original, criar identificador e hora de chegada. |
| Orquestração assíncrona | Queues ou Workflows | Estado durável, tentativas limitadas, retomada e registro de falhas. |
| OCR/extração de política e despesa | Worker chamando provedor de IA/OCR | Portar prompts e schemas, tratar arquivos multipágina, medir tokens/custo. |
| Catálogo por empresa e versão | Banco transacional existente ou D1 | Aprovação de política, versionamento, vigência, isolamento e idempotência. |
| Checagens V1–V8 e confronto | Código TypeScript no Worker | Portar funções determinísticas, cobrir divergências de número/chave e subtotal/taxa, executar regressão contra saídas n8n. |
| Resultado e auditoria | Worker + armazenamento transacional | Persistir dados lidos, eventos e hashes; devolver callback, tratar falha e duplicação. |

**Critério de corte:** para cada PDF e nota de referência, a execução nativa deve reproduzir os campos, evidências, regras aplicáveis, decisão e auditoria do fluxo validado; divergências precisam de revisão humana. Não desligue o n8n só porque o gateway foi publicado.

Referências: [Workers](https://developers.cloudflare.com/workers/), [Workflows](https://developers.cloudflare.com/workflows/), [R2](https://developers.cloudflare.com/r2/), [Queues](https://developers.cloudflare.com/queues/).
