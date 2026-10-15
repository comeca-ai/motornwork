const finite = x => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null;
const total = (rows, field) => rows.length && rows.every(r => finite(r[field]) !== null) ? rows.reduce((n,r) => n+r[field],0) : null;
export function metrics(record) {
 const m = record.result?.medicao ?? {};
 const tabela = Array.isArray(m.tabela) ? m.tabela : [];
 const elapsed = record.completedAt ? Date.parse(record.completedAt)-Date.parse(record.createdAt) : null;
 const duration=finite(m.totalTempoMs) ?? finite(Date.parse(m.fim)-Date.parse(m.inicio));
 const cost=tabela.length && tabela.some(r=>finite(r.custoUSD)===null) ? null : finite(m.totalUSD);
 return {medicao:record.result?.medicao ?? null, totalUSD:cost, totalTempoMs:duration,
  tempoPontaAPontaMs:finite(elapsed), inputTokens:total(tabela,'inputTokens'), outputTokens:total(tabela,'outputTokens'), tabela};
}
export async function indexRecord(db, record) {
 if (!db) return false;
 const m=metrics(record);
 await db.prepare(`INSERT INTO requests
 (id,client_id,request_id,type,policy_version,vendedor_id,created_at,completed_at,state,decision,revision,total_usd,processing_ms,elapsed_ms,input_tokens,output_tokens,stages_json,indexed_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET state=excluded.state,completed_at=excluded.completed_at,decision=excluded.decision,
 revision=excluded.revision,total_usd=excluded.total_usd,processing_ms=excluded.processing_ms,elapsed_ms=excluded.elapsed_ms,
 input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,stages_json=excluded.stages_json,indexed_at=excluded.indexed_at
 WHERE excluded.revision >= requests.revision`).bind(
 record.id,record.clientId,record.requestId,record.type,record.policyVersion,record.vendedorId ?? null,
 record.createdAt,record.completedAt ?? null,record.state,record.result?.parecer?.decisao ?? record.result?.status ?? null,
 record.revision ?? 0,m.totalUSD,m.totalTempoMs,m.tempoPontaAPontaMs,m.inputTokens,m.outputTokens,
 JSON.stringify(m.tabela),new Date().toISOString()).run();
 return true;
}
export async function tryIndex(db,record) {
 try { return await indexRecord(db,record); }
 catch { console.error('D1_INDEX_PENDING',record.id); return false; }
}
export function filters(params) {
 const parts=['requests.client_id = ?'], args=[params.get('clientId')];
 for(const [key,column] of [['type','type'],['state','state'],['decision','decision'],['vendedorId','vendedor_id'],['requestId','request_id'],['policyVersion','policy_version']]) {
  const value=params.get(key); if(value!==null) {if(!value || value.length>128)throw new Error(`Filtro ${key} inválido`); parts.push(`requests.${column} = ?`);args.push(value);}
 }
 for(const [key,operator] of [['from','>='],['to','<']]) {
  const value=params.get(key);if(value!==null){
   if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('from/to devem ser datas ISO UTC');
   parts.push(`requests.created_at ${operator} ?`);args.push(new Date(value).toISOString());
  }
 }
 if(params.get('from')&&params.get('to')&&Date.parse(params.get('from'))>=Date.parse(params.get('to')))throw new Error('from deve ser anterior a to');
 return {where:parts.join(' AND '),args};
}
function item(r) {
 return {id:r.id,clientId:r.client_id,requestId:r.request_id,type:r.type,policyVersion:r.policy_version,vendedorId:r.vendedor_id,
 createdAt:r.created_at,completedAt:r.completed_at,state:r.state,decision:r.decision,
 totalUSD:r.total_usd,totalTempoMs:r.processing_ms,tempoPontaAPontaMs:r.elapsed_ms,
 inputTokens:r.input_tokens,outputTokens:r.output_tokens,indexedAt:r.indexed_at,
 consultaPath:`/api/v1/solicitacoes/${r.id}?clientId=${encodeURIComponent(r.client_id)}`};
}
export async function listRequests(db,params) {
 const {where,args}=filters(params);const raw=params.get('limit')??'25';
 if(!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>100)throw new Error('limit deve estar entre 1 e 100');
 const limit=Number(raw);let seek='';
 if(params.has('cursor')){
  let c;try{c=JSON.parse(atob(params.get('cursor')));}catch{throw new Error('Cursor inválido');}
  if(!c||typeof c.date!=='string'||!Number.isFinite(Date.parse(c.date))||! /^[0-9a-f-]{36}$/.test(c.id))throw new Error('Cursor inválido');
  seek=' AND (created_at < ? OR (created_at = ? AND id < ?))';args.push(c.date,c.date,c.id);
 }
 const {results}=await db.prepare(`SELECT * FROM requests WHERE ${where}${seek} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...args,limit+1).all();
 const page=results.slice(0,limit),last=page.at(-1);
 return {items:page.map(item),nextCursor:results.length>limit?btoa(JSON.stringify({date:last.created_at,id:last.id})):null};
}
export async function report(db,params) {
 const {where,args}=filters(params);
 const summary=await db.prepare(`SELECT COUNT(*) AS solicitacoes,COUNT(total_usd) AS comCusto,
 SUM(total_usd) AS custoTotalUSD,COUNT(processing_ms) AS comTempo,
 SUM(processing_ms) AS tempoProcessamentoSomadoMs,AVG(processing_ms) AS tempoProcessamentoMedioMs,
 AVG(elapsed_ms) AS tempoPontaAPontaMedioMs, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
 COUNT(input_tokens) AS comInputTokens,COUNT(output_tokens) AS comOutputTokens FROM requests WHERE ${where}`).bind(...args).first();
 const {results:porStatus}=await db.prepare(`SELECT type,state,decision,COUNT(*) AS quantidade FROM requests WHERE ${where} GROUP BY type,state,decision`).bind(...args).all();
 const {results:porEtapa}=await db.prepare(`SELECT json_extract(j.value,'$.bloco') AS bloco,json_extract(j.value,'$.modelo') AS modelo,
 COUNT(*) AS ocorrencias, COUNT(json_extract(j.value,'$.custoUSD')) AS comCusto,
 SUM(json_extract(j.value,'$.custoUSD')) AS custoUSD,
 COUNT(json_extract(j.value,'$.tempoMs')) AS comTempo, SUM(json_extract(j.value,'$.tempoMs')) AS tempoSomadoMs,
 AVG(json_extract(j.value,'$.tempoMs')) AS tempoMedioMs,
 SUM(json_extract(j.value,'$.inputTokens')) AS inputTokens,SUM(json_extract(j.value,'$.outputTokens')) AS outputTokens
 FROM requests,json_each(requests.stages_json) AS j WHERE ${where}
 GROUP BY bloco,modelo ORDER BY bloco,modelo`).bind(...args).all();
 return {schema:'relatorio-processamento-v1',clientId:params.get('clientId'),geradoEm:new Date().toISOString(),
 filtros:Object.fromEntries(params),moeda:'USD',custoEstimado:true,infraestruturaIncluida:false,
 resumo:summary,porStatus,porEtapa,observacao:'Somas incluem apenas medições conhecidas; consulte contagens de cobertura. Período filtra o recebimento, não a emissão da nota. Índice reconstruível a partir do R2.'};
}
