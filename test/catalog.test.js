import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { metrics,indexRecord,listRequests,report } from '../src/catalog.js';
import { handleRequest } from '../src/index.js';
function database() {
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0001_requests.sql',import.meta.url),'utf8'));
 return {prepare(sql){return {bind(...args){return {async run(){db.prepare(sql).run(...args);return {success:true};},async all(){return {results:db.prepare(sql).all(...args)};},async first(){return db.prepare(sql).get(...args)??null;}};}};}};
}
const row=(id,clientId='100',extra={})=>({id,clientId,requestId:id,type:'despesa',policyVersion:'v1',vendedorId:'v1',createdAt:'2026-10-14T12:00:00.000Z',completedAt:'2026-10-14T12:00:10.000Z',state:'completed',revision:2,result:{status:'revisao',medicao:{totalUSD:.1,totalTempoMs:8000,tabela:[{bloco:'OCR',modelo:'modelo-teste',tempoMs:8000,inputTokens:10,outputTokens:20,custoUSD:.1}]}},...extra});
const ids=['10000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003'];
test('índice isola empresas, pagina sem repetição e preserva revisão mais nova',async()=>{
 const db=database();await indexRecord(db,row(ids[0]));await indexRecord(db,row(ids[1]));await indexRecord(db,row(ids[2],'101'));
 await indexRecord(db,row(ids[0],'100',{state:'pending',revision:1,result:null}));
 let p=new URLSearchParams({clientId:'100',limit:'1'});const first=await listRequests(db,p);assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 p.set('cursor',first.nextCursor);const second=await listRequests(db,p);assert.equal(second.nextCursor,null);assert.notEqual(first.items[0].id,second.items[0].id);assert.equal(second.items[0].state,'completed');
 const malicious=await listRequests(db,new URLSearchParams({clientId:'100',requestId:"' OR 1=1 --"}));assert.equal(malicious.items.length,0);
});
test('relatório agrega custo/tempo com cobertura, sem transformar null em zero',async()=>{
 const db=database();await indexRecord(db,row(ids[0]));await indexRecord(db,row(ids[1],'100',{result:null,state:'pending',completedAt:null}));await indexRecord(db,row(ids[2],'101'));
 const r=await report(db,new URLSearchParams({clientId:'100',type:'despesa'}));assert.equal(r.resumo.solicitacoes,2);assert.equal(r.resumo.comCusto,1);assert.equal(r.resumo.custoTotalUSD,.1);assert.equal(r.resumo.tempoPontaAPontaMedioMs,10000);assert.equal(r.porEtapa[0].custoUSD,.1);
 assert.equal(metrics(row(ids[1],'100',{result:null})).totalUSD,null);
 assert.equal((await report(db,new URLSearchParams({clientId:'999'}))).resumo.custoTotalUSD,null);
 await assert.rejects(()=>listRequests(db,new URLSearchParams({clientId:'100',limit:'-1'})));
 await assert.rejects(()=>report(db,new URLSearchParams({clientId:'100',from:'ontem'})));
});
test('consulta individual exige integração, recusa outra empresa e não depende do D1',async()=>{
 const secret='test-token-000000000000000000000000000';const env={INTEGRATION_TOKEN_SHA256:createHash('sha256').update(secret).digest('hex'),N8N_WEBHOOK_SECRET:'x'.repeat(64),RESULTS_BUCKET:{async get(){return {etag:'1',text:async()=>JSON.stringify(row(ids[0]))};}}};
 const url=`https://test.local/api/v1/solicitacoes/${ids[0]}`;
 assert.equal((await handleRequest(new Request(url+'?clientId=100'),env)).status,401);
 const req=clientId=>new Request(url+'?clientId='+clientId,{headers:{Authorization:'Bearer '+secret}});
 assert.equal((await handleRequest(req('101'),env)).status,404);
 assert.equal((await handleRequest(req('100'),env)).status,200);
});
test('entrada → R2 → callback → D1 → relatório preserva original e metadados',async()=>{
 const objects=new Map();let revision=0;
 const bucket={async put(key,value,opts={}){const old=objects.get(key);if(opts.onlyIf?.etagDoesNotMatch==='*'&&old)return null;if(opts.onlyIf?.etagMatches&&opts.onlyIf.etagMatches!==old?.etag)return null;const etag=String(++revision);objects.set(key,{value,etag});return {etag};},async get(key){const x=objects.get(key);if(!x)return null;return {etag:x.etag,body:x.value,text:async()=>typeof x.value==='string'?x.value:new TextDecoder().decode(x.value)};},async delete(key){objects.delete(key);},async list(){return {objects:[...objects.keys()].filter(k=>k.startsWith('requests/')).map(key=>({key})),truncated:false};}};
 const token='integration-test-token-0000000000000000000000000';
 const env={INDEX_DB:database(),RESULTS_BUCKET:bucket,N8N_BASE_URL:'https://n8n.test',N8N_WEBHOOK_SECRET:'x'.repeat(64),INTEGRATION_TOKEN_SHA256:createHash('sha256').update(token).digest('hex')};
 const headers={Authorization:'Bearer '+token},form=new FormData();
 for(const [k,v] of Object.entries({clientId:'100',requestId:'e2e',policyVersion:'v1',vendedorId:'v42',politicaJson:JSON.stringify({clientId:'100',policyVersion:'v1',categorias:[{id:'refeicao'}],regras:[],regrasGerais:[]})}))form.set(k,v);
 form.set('arquivo',new File(['original'],'recibo.jpg',{type:'image/jpeg'}));let callback;
 const received=await handleRequest(new Request('https://motor.test/webhook/modelo/v1/despesas/analisar',{method:'POST',headers,body:form}),env,async(url,opts)=>{callback=(await new Request(url,opts).formData()).get('callbackUrl');return new Response('{}',{status:202});});
 const receipt=await received.json();assert.equal(received.status,202);
 const result={...row(ids[0]).result,clientId:'100',requestId:'e2e',policyVersion:'v1'};const raw=JSON.stringify(result,null,2);
 assert.equal((await handleRequest(new Request(callback,{method:'POST',body:raw}),env)).status,200);
 const get=path=>handleRequest(new Request('https://motor.test'+path,{headers}),env);
 const list=await (await get('/api/v1/solicitacoes?clientId=100&vendedorId=v42')).json();assert.equal(list.items[0].state,'completed');assert.equal(list.items[0].totalUSD,.1);
 const detail=await (await get(list.items[0].consultaPath)).json();assert.equal(detail.entrada.vendedorId,'v42');assert.equal(detail.readTokenHash,undefined);
 assert.equal(await (await get(`/api/v1/solicitacoes/${receipt.id}/arquivo?clientId=100`)).text(),'original');
 assert.equal(await (await get(`/api/v1/solicitacoes/${receipt.id}/resultado-original?clientId=100`)).text(),raw);
 assert.equal((await (await get('/api/v1/relatorios/processamento?clientId=100')).json()).resumo.solicitacoes,1);
 assert.equal((await get(`/api/v1/solicitacoes/${receipt.id}?clientId=101`)).status,404);
 // A D1 failure must not lose or reject an already stored callback.
 env.INDEX_DB={prepare(){throw new Error('D1 indisponível');}};
 assert.equal((await handleRequest(new Request(callback,{method:'POST',body:raw}),env)).status,200);
 assert.equal((await get(`/api/v1/solicitacoes/${receipt.id}?clientId=100`)).status,200);
});
