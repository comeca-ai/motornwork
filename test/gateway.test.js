import test from 'node:test';
import { createHash } from 'node:crypto';
const entryToken = 'test-only-integration-token-0000000000000000';
const authHeaders = { authorization: `Bearer ${entryToken}` };
const authEnv = { INTEGRATION_TOKEN_SHA256: createHash('sha256').update(entryToken).digest('hex'), N8N_WEBHOOK_SECRET: 'test-only-upstream-secret-000000000000000000' };
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';

const base = 'https://gateway.example.test';
function memoryBucket() {
  const objects = new Map();
  let version = 0;
  return {
    async put(key, value, options = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.etagDoesNotMatch === '*' && current) return null;
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      const etag = String(++version);
      objects.set(key, { value: typeof value === 'string' ? value : new Uint8Array(value), etag });
      return { etag };
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return { etag: object.etag, text: async () => typeof object.value === 'string' ? object.value : new TextDecoder().decode(object.value) };
    },
    async delete(key) { objects.delete(key); },
  };
}
const env = { ...authEnv, N8N_BASE_URL: 'https://primary-production-052d.up.railway.app', RESULTS_BUCKET: memoryBucket() };
function expenseRequest(overrides = {}) {
  const form = new FormData();
  form.set('clientId', '100');
  form.set('requestId', 'despesa-001');
  form.set('policyVersion', 'v1');
  form.set('politicaJson', JSON.stringify({ clientId: '100', policyVersion: 'v1', categorias: [{ id: 'refeicao' }], regras: [], regrasGerais: [] }));
  form.set('arquivo', new File(['nota de teste'], 'nota.txt', { type: 'text/plain' }));
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form, headers: authHeaders });
}

test('despesa preserva arquivo e encaminha resposta 202 do n8n', async () => {
  let sent = false;
  const response = await handleRequest(expenseRequest(), env, async (url, options) => {
    sent = true;
    assert.equal(url, env.N8N_BASE_URL + '/webhook/modelo/v1/despesas/analisar');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-Motor-Secret'], authEnv.N8N_WEBHOOK_SECRET);
    assert.equal(options.headers.authorization, undefined);
    const form = await new Request(url, { method: 'POST', headers: options.headers, body: options.body }).formData();
    assert.equal(form.get('clientId'), '100');
    assert.equal(await form.get('arquivo').text(), 'nota de teste');
    return new Response(JSON.stringify({ status: 'recebido', requestId: 'despesa-001' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(sent, true);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'recebido');
});

test('bloqueia callback externo antes de encaminhar', async () => {
  const response = await handleRequest(expenseRequest({ callbackUrl: 'https://transacional.example.com/callback' }), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 400);
});

test('política PDF usa a rota correta', async () => {
  const form = new FormData();
  form.set('clientId', '100');
  form.set('requestId', 'politica-001');
  form.set('policyVersion', 'v2');
  form.set('action', 'update');
  form.set('arquivo', new File(['%PDF-1.7\n'], 'politica.pdf', { type: 'application/pdf' }));
  const request = new Request(base + '/webhook/modelo/v1/politicas/processar', { method: 'POST', body: form, headers: authHeaders });
  const response = await handleRequest(request, env, async (url) => {
    assert.equal(url, env.N8N_BASE_URL + '/webhook/modelo/v1/politicas/processar');
    return new Response('{"status":"recebido"}', { status: 202, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(response.status, 202);
});

test('health não chama o n8n', async () => {
  const response = await handleRequest(new Request(base + '/health'), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 200);
});

test('raiz informa as rotas disponíveis', async () => {
  const response = await handleRequest(new Request(base + '/'), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.endpoints.map(({ path }) => path), [
    '/webhook/modelo/v1/politicas/processar',
    '/webhook/modelo/v1/despesas/analisar',
    '/resultados/v1/{id}',
  ]);
});

test('rejeita politicaJson truncado antes de chamar o n8n', async () => {
  const response = await handleRequest(expenseRequest({ politicaJson: '{"regras": [' }), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /JSON válido/);
});

test('rejeita catálogo sem categorias antes de chamar o n8n', async () => {
  const policy = { clientId: '100', policyVersion: 'v1', categorias: [], regras: [], regrasGerais: [] };
  const response = await handleRequest(expenseRequest({ politicaJson: JSON.stringify(policy) }), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Catálogo da política inválido/);
});

test('callback próprio guarda resultado e permite consulta pelo recibo', async () => {
  const internalEnv = { ...authEnv, ...env, RESULTS_BUCKET: memoryBucket() };
  const form = await expenseRequest().formData();
  const request = new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form, headers: authHeaders });
  let callbackUrl;
  const receipt = await handleRequest(request, internalEnv, async (upstreamUrl, options) => {
    const forwarded = await new Request(upstreamUrl, { method: 'POST', headers: options.headers, body: options.body }).formData();
    callbackUrl = forwarded.get('callbackUrl');
    assert.match(callbackUrl, /^https:\/\/gateway\.example\.test\/callbacks\/v1\//);
    assert.equal(forwarded.get('clientId'), '100');
    assert.equal(await forwarded.get('arquivo').text(), 'nota de teste');
    return new Response(JSON.stringify({ status: 'recebido', requestId: 'despesa-001' }), { status: 202, headers: { 'content-type': 'application/json' } });
  });
  assert.equal(receipt.status, 202);
  const { resultUrl, resultToken } = await receipt.json();
  assert.match(resultUrl, /^https:\/\/gateway\.example\.test\/resultados\/v1\//);
  assert.doesNotMatch(resultUrl, /token=/);
  const resultRequest = () => new Request(resultUrl, { headers: { authorization: `Bearer ${resultToken}` } });
  const pending = await handleRequest(resultRequest(), internalEnv);
  assert.equal(pending.status, 202);
  assert.equal((await pending.json()).state, 'pending');
  const result = { clientId: '100', requestId: 'despesa-001', policyVersion: 'v1', status: 'aprovado', dados: { total: 60.17 } };
  const callback = await handleRequest(new Request(callbackUrl, { method: 'POST', body: JSON.stringify(result), headers: { 'content-type': 'application/json' } }), internalEnv);
  assert.equal(callback.status, 200);
  const completed = await handleRequest(resultRequest(), internalEnv);
  assert.equal(completed.status, 200);
  assert.deepEqual((await completed.json()).result, result);
  const repeated = await handleRequest(new Request(callbackUrl, { method: 'POST', body: JSON.stringify(result) }), internalEnv);
  assert.equal(repeated.status, 200);
  const conflicting = await handleRequest(new Request(callbackUrl, { method: 'POST', body: JSON.stringify({ ...result, status: 'negado' }) }), internalEnv);
  assert.equal(conflicting.status, 409);
  const noToken = await handleRequest(new Request(resultUrl), internalEnv);
  assert.equal(noToken.status, 404);
  const unauthorized = await handleRequest(new Request(resultUrl, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } }), internalEnv);
  assert.equal(unauthorized.status, 404);
  const duplicate = await handleRequest(new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form, headers: authHeaders }), internalEnv, () => { throw new Error('não deve reenviar ao n8n'); });
  assert.equal(duplicate.status, 409);
});

for (const [name, authorization] of [['ausente', null], ['incorreto', 'Bearer wrong-token-0000000000000000000000']]) {
 test(`entrada bloqueia token ${name} antes do encaminhamento`, async () => {
  const r = expenseRequest();r.headers.delete('authorization');if (authorization) r.headers.set('authorization', authorization);
  const response = await handleRequest(r, env, () => { throw new Error('não encaminhar'); });
  assert.equal(response.status, 401);
 });
}
test('token válido não autoriza empresa diferente', async () => {
 const response = await handleRequest(expenseRequest({clientId:'outra_empresa'}), env, () => { throw new Error('não encaminhar'); });
 assert.equal(response.status,403);
});
test('configuração ausente ou inválida bloqueia entrada', async () => {
 for(const config of [{...env,INTEGRATION_TOKEN_SHA256:undefined},{...env,INTEGRATION_TOKEN_SHA256:'invalid'},{...env,N8N_WEBHOOK_SECRET:undefined}]) {
  const response = await handleRequest(expenseRequest(),config,()=>{throw new Error('não encaminhar');});assert.equal(response.status,503);
 }
});

for (const clientId of ['100', '101', '999', '1000']) {
 test(`faixa permite ${clientId}`, async () => {
  const policy={clientId,policyVersion:'v1',categorias:[{id:'refeicao'}],regras:[],regrasGerais:[]};
  let sent=0;
  const response=await handleRequest(expenseRequest({clientId,politicaJson:JSON.stringify(policy)}),{...env,RESULTS_BUCKET:memoryBucket()},async()=>{sent++;return new Response('{}',{status:202});});
  assert.equal(response.status,202);assert.equal(sent,1);
 });
}
for (const clientId of ['99','1001','0100','001000','100.0','1e2','-100','stefanini','100 ','100\n']) {
 test(`faixa bloqueia ${JSON.stringify(clientId)}`,async()=>{
  const response=await handleRequest(expenseRequest({clientId}),env,()=>{throw new Error('não encaminhar');});
  assert.ok([400,403].includes(response.status));
 });
}

test('callback entrega JSON completo, preserva falha e permite reenvio sem OCR', async () => {
 const localEnv = {...env, RESULTS_BUCKET:memoryBucket(), CLIENT_CALLBACK_URL:'https://sistema.example.test/retorno', CLIENT_CALLBACK_TOKEN:'test-secret'};
 let internalCallback;
 const accepted = await handleRequest(expenseRequest(),localEnv,async (url,options)=>{
  const form=await new Request(url,{...options}).formData();internalCallback=form.get('callbackUrl');
  assert.notEqual(internalCallback,localEnv.CLIENT_CALLBACK_URL);
  return new Response('{}',{status:202});
 });
 const receipt=await accepted.json();
 const result={clientId:'100',requestId:'despesa-001',policyVersion:'v1',medicao:{tempo:23,custo:0.1},auditoria:{hash:'abc'},ocr:'texto integral'};
 let attempts=0;
 const deliver=async(url,options)=>{
  attempts++;assert.equal(url,localEnv.CLIENT_CALLBACK_URL);assert.deepEqual(JSON.parse(options.body),result);
  assert.equal(options.headers.Authorization,'Bearer test-secret');assert.ok(options.headers['Idempotency-Key']);assert.equal(options.redirect,'manual');
  return new Response(null,{status:attempts===1?503:204});
 };
 const delivery=deliver;
 const callback=()=>new Request(internalCallback,{method:'POST',body:JSON.stringify(result)});
 assert.equal((await handleRequest(callback(),localEnv,delivery)).status,502);
 const read=()=>new Request(receipt.resultUrl,{headers:{authorization:`Bearer ${receipt.resultToken}`}});
 let record=await (await handleRequest(read(),localEnv)).json();
 assert.equal(record.state,'completed');assert.equal(record.delivery.state,'failed');assert.deepEqual(record.result,result);assert.equal(record.deliveryUrl,undefined);
 assert.equal((await handleRequest(new Request(receipt.resultUrl+'/reenviar',{method:'POST',headers:{authorization:`Bearer ${receipt.resultToken}`}}),localEnv,delivery)).status,200);
 assert.equal((await handleRequest(callback(),localEnv,delivery)).status,200);assert.equal(attempts,2);
 record=await (await handleRequest(read(),localEnv)).json();assert.equal(record.delivery.state,'delivered');
});
