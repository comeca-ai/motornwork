import test from 'node:test';
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
const env = { N8N_BASE_URL: 'https://primary-production-052d.up.railway.app', RESULTS_BUCKET: memoryBucket() };
function expenseRequest(overrides = {}) {
  const form = new FormData();
  form.set('clientId', 'empresa_123');
  form.set('requestId', 'despesa-001');
  form.set('policyVersion', 'v1');
  form.set('politicaJson', JSON.stringify({ clientId: 'empresa_123', policyVersion: 'v1', categorias: [{ id: 'refeicao' }], regras: [], regrasGerais: [] }));
  form.set('arquivo', new File(['nota de teste'], 'nota.txt', { type: 'text/plain' }));
  for (const [key, value] of Object.entries(overrides)) form.set(key, value);
  return new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form });
}

test('despesa preserva arquivo e encaminha resposta 202 do n8n', async () => {
  let sent = false;
  const response = await handleRequest(expenseRequest(), env, async (url, options) => {
    sent = true;
    assert.equal(url, env.N8N_BASE_URL + '/webhook/modelo/v1/despesas/analisar');
    assert.equal(options.method, 'POST');
    const form = await new Request(url, { method: 'POST', headers: options.headers, body: options.body }).formData();
    assert.equal(form.get('clientId'), 'empresa_123');
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
  form.set('clientId', 'empresa_123');
  form.set('requestId', 'politica-001');
  form.set('policyVersion', 'v2');
  form.set('action', 'update');
  form.set('arquivo', new File(['%PDF-1.7\n'], 'politica.pdf', { type: 'application/pdf' }));
  const request = new Request(base + '/webhook/modelo/v1/politicas/processar', { method: 'POST', body: form });
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
  const policy = { clientId: 'empresa_123', policyVersion: 'v1', categorias: [], regras: [], regrasGerais: [] };
  const response = await handleRequest(expenseRequest({ politicaJson: JSON.stringify(policy) }), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Catálogo da política inválido/);
});

test('callback próprio guarda resultado e permite consulta pelo recibo', async () => {
  const internalEnv = { ...env, RESULTS_BUCKET: memoryBucket() };
  const form = await expenseRequest().formData();
  const request = new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form });
  let callbackUrl;
  const receipt = await handleRequest(request, internalEnv, async (upstreamUrl, options) => {
    const forwarded = await new Request(upstreamUrl, { method: 'POST', headers: options.headers, body: options.body }).formData();
    callbackUrl = forwarded.get('callbackUrl');
    assert.match(callbackUrl, /^https:\/\/gateway\.example\.test\/callbacks\/v1\//);
    assert.equal(forwarded.get('clientId'), 'empresa_123');
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
  const result = { clientId: 'empresa_123', requestId: 'despesa-001', policyVersion: 'v1', status: 'aprovado', dados: { total: 60.17 } };
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
  const duplicate = await handleRequest(new Request(base + '/webhook/modelo/v1/despesas/analisar', { method: 'POST', body: form }), internalEnv, () => { throw new Error('não deve reenviar ao n8n'); });
  assert.equal(duplicate.status, 409);
});
