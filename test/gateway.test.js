import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';

const base = 'https://gateway.example.test';
const env = { N8N_BASE_URL: 'https://primary-production-052d.up.railway.app' };
function expenseRequest(overrides = {}) {
  const form = new FormData();
  form.set('clientId', 'empresa_123');
  form.set('requestId', 'despesa-001');
  form.set('policyVersion', 'v1');
  form.set('callbackUrl', 'https://transacional.example.com/callback');
  form.set('politicaJson', JSON.stringify({ clientId: 'empresa_123', policyVersion: 'v1' }));
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
  assert.deepEqual(await response.json(), { status: 'recebido', requestId: 'despesa-001' });
});

test('bloqueia callback inseguro antes de encaminhar', async () => {
  const response = await handleRequest(expenseRequest({ callbackUrl: 'http://localhost:8080/callback' }), env, () => { throw new Error('não deve encaminhar'); });
  assert.equal(response.status, 400);
});

test('política PDF usa a rota correta', async () => {
  const form = new FormData();
  form.set('clientId', 'empresa_123');
  form.set('requestId', 'politica-001');
  form.set('policyVersion', 'v2');
  form.set('callbackUrl', 'https://transacional.example.com/callback');
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
