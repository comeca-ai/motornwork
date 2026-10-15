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
