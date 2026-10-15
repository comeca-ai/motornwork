/** Node 22+, SERVER ONLY. Token never goes to frontend. No automatic POST retries. */
export class MotorClient {
 constructor({token,base='https://motornwork.jhonata-emerick.workers.dev',fetchImpl=fetch}) {
  if(!token)throw new Error('Configure MOTOR_TOKEN no servidor');
  this.token=token;this.base=base.replace(/\/$/,'');this.fetch=fetchImpl;
 }
 async call(path,options={}) {
  const response=await this.fetch(this.base+path,{...options,headers:{...options.headers,Authorization:`Bearer ${this.token}`},redirect:'error'});
  const text=await response.text();let body;try{body=JSON.parse(text);}catch{body={message:text};}
  if(!response.ok){const error=new Error(`Motor HTTP ${response.status}`);error.status=response.status;error.body=body;throw error;}
  return {httpStatus:response.status,body};
 }
 async sendPolicy({clientId,requestId,policyVersion,action='create',arquivo}) {
  const form=new FormData();for(const [key,value] of Object.entries({clientId,requestId,policyVersion,action}))form.set(key,String(value));
  form.set('arquivo',arquivo);return this.call('/webhook/modelo/v1/politicas/processar',{method:'POST',body:form});
 }
 async sendExpense({clientId,requestId,policyVersion,politicaJson,arquivo,vendedorId}) {
  if(politicaJson.clientId!==String(clientId)||politicaJson.policyVersion!==policyVersion)throw new Error('Catálogo de outra empresa/versão');
  const form=new FormData();for(const [key,value] of Object.entries({clientId,requestId,policyVersion}))form.set(key,String(value));
  if(vendedorId)form.set('vendedorId',vendedorId);
  form.set('politicaJson',JSON.stringify(politicaJson));form.set('arquivo',arquivo);
  return this.call('/webhook/modelo/v1/despesas/analisar',{method:'POST',body:form});
 }
 list(clientId,filters={}) {return this.call('/api/v1/solicitacoes?'+new URLSearchParams({...filters,clientId:String(clientId)}));}
 detail(clientId,id) {return this.call(`/api/v1/solicitacoes/${encodeURIComponent(id)}?`+new URLSearchParams({clientId:String(clientId)}));}
 measurement(clientId,id) {return this.call(`/api/v1/solicitacoes/${encodeURIComponent(id)}/medicao?`+new URLSearchParams({clientId:String(clientId)}));}
 report(clientId,filters={}) {return this.call('/api/v1/relatorios/processamento?'+new URLSearchParams({...filters,clientId:String(clientId)}));}
 async file(clientId,id) {
  const response=await this.fetch(`${this.base}/api/v1/solicitacoes/${encodeURIComponent(id)}/arquivo?`+new URLSearchParams({clientId:String(clientId)}),{headers:{Authorization:`Bearer ${this.token}`},redirect:'error'});
  if(!response.ok)throw new Error(`Arquivo HTTP ${response.status}`);return response;
 }
}
/** Only presentation: retain the original JSON alongside this projection. */
export function expenseView(record) {
 const result=record.result??{},d=result.despesa??{},p=result.parecer??{};
 return {id:record.id,processamento:record.state,decisao:p.decisao??result.status??null,
  estabelecimento:d.estabelecimento??null,valor:d.valorTotal??null,moeda:d.moeda??null,
  itens:d.itens??[],resumo:p.resumo??null,pendencias:p.condicoesNaoVerificaveis??[],
  verificacoes:result.validacao?.verificacoes??[],etapas:result.medicao?.tabela??[],
  custoEstimadoUSD:result.medicao?.totalUSD??null,auditoria:result.auditoria??null};
}
