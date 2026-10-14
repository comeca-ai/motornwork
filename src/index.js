const ROUTES = new Map([
  ['/webhook/modelo/v1/politicas/processar', '/webhook/modelo/v1/politicas/processar'],
  ['/webhook/modelo/v1/despesas/analisar', '/webhook/modelo/v1/despesas/analisar'],
]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_CALLBACK_BYTES = 16 * 1024 * 1024;

const recordKey = id => `requests/${id}.json`;
const fileKey = id => `files/${id}`;
const indexKey = hash => `unique/${hash}.txt`;

function token() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function loadRecord(bucket, id) {
  const object = await bucket.get(recordKey(id));
  if (!object) return null;
  const record = JSON.parse(await object.text());
  Object.defineProperty(record, '_etag', { value: object.etag, enumerable: false });
  return record;
}

async function saveRecord(bucket, record) {
  const saved = await bucket.put(recordKey(record.id), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
    ...(record._etag ? { onlyIf: { etagMatches: record._etag } } : {}),
  });
  if (saved === null) throw new Error('Registro alterado por outra execução');
}

async function markUpstreamError(bucket, id, status) {
  try {
    const latest = await loadRecord(bucket, id);
    if (!latest || latest.state !== 'pending') return;
    latest.state = 'upstream_error';
    if (status) latest.upstreamStatus = status;
    await saveRecord(bucket, latest);
  } catch { /* preserve the original error response */ }
}

function publicRecord(record) {
  const { readTokenHash, callbackTokenHash, ...visible } = record;
  return visible;
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}

function validClientId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value);
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') {
    return json(200, {
      service: 'motornwork-gateway',
      description: 'Gateway de entrada para o motor n8n. Envie arquivos por POST e consulte o resultado pela URL devolvida no recibo.',
      health: '/health',
      endpoints: [
        { method: 'POST', path: '/webhook/modelo/v1/politicas/processar' },
        { method: 'POST', path: '/webhook/modelo/v1/despesas/analisar' },
        { method: 'GET', path: '/resultados/v1/{id}', auth: 'Authorization: Bearer {resultToken}' },
      ],
    });
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    return json(200, { status: 'ok', service: 'motornwork-gateway' });
  }
  const resultMatch = url.pathname.match(/^\/resultados\/v1\/([0-9a-f-]{36})$/);
  if (resultMatch) {
    if (request.method !== 'GET') return json(405, { error: 'Use GET' });
    if (!env.RESULTS_BUCKET) return json(503, { error: 'Armazenamento de resultados não configurado' });
    const supplied = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (!supplied) return json(404, { error: 'Resultado não encontrado' });
    const record = await loadRecord(env.RESULTS_BUCKET, resultMatch[1]);
    if (!record || !equalHash(await sha256(supplied), record.readTokenHash)) return json(404, { error: 'Resultado não encontrado' });
    const state = record.state === 'pending' && Date.now() - Date.parse(record.createdAt) > 300000 ? 'aguardando_mais_que_5_minutos' : record.state;
    const response = json(record.state === 'pending' ? 202 : 200, { ...publicRecord(record), state });
    if (record.state === 'pending') response.headers.set('retry-after', '5');
    return response;
  }
  const callbackMatch = url.pathname.match(/^\/callbacks\/v1\/([0-9a-f-]{36})$/);
  if (callbackMatch) {
    if (request.method !== 'POST') return json(405, { error: 'Use POST' });
    if (!env.RESULTS_BUCKET) return json(503, { error: 'Armazenamento de resultados não configurado' });
    const supplied = url.searchParams.get('token');
    if (!supplied || !/^[0-9a-f]{64}$/.test(supplied)) return json(404, { error: 'Solicitação não encontrada' });
    const record = await loadRecord(env.RESULTS_BUCKET, callbackMatch[1]);
    if (!record || !equalHash(await sha256(supplied), record.callbackTokenHash)) return json(404, { error: 'Solicitação não encontrada' });
    const length = Number(request.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_CALLBACK_BYTES) return json(413, { error: 'Callback acima de 16 MB' });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_CALLBACK_BYTES) return json(413, { error: 'Callback acima de 16 MB' });
    let result;
    try { result = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return json(400, { error: 'Callback deve ser JSON válido' }); }
    if (!result || typeof result !== 'object' || Array.isArray(result) || result.clientId !== record.clientId || result.requestId !== record.requestId || result.policyVersion !== record.policyVersion) {
      return json(400, { error: 'Identidade do callback não corresponde à solicitação' });
    }
    const digest = await sha256(bytes);
    if (record.state === 'completed') {
      return equalHash(record.resultSha256, digest) ? json(200, { status: 'ja_recebido' }) : json(409, { error: 'Resultado diferente já armazenado' });
    }
    record.state = 'completed';
    record.completedAt = new Date().toISOString();
    record.resultSha256 = digest;
    record.result = result;
    try { await saveRecord(env.RESULTS_BUCKET, record); }
    catch {
      const latest = await loadRecord(env.RESULTS_BUCKET, callbackMatch[1]);
      return latest?.state === 'completed' && equalHash(latest.resultSha256, digest)
        ? json(200, { status: 'ja_recebido' })
        : json(409, { error: 'Resultado diferente já armazenado' });
    }
    return json(200, { status: 'armazenado', requestId: record.requestId });
  }
  const upstreamPath = ROUTES.get(url.pathname);
  if (!upstreamPath) return json(404, { error: 'Rota não encontrada', endpoints: ['/', '/health', ...ROUTES.keys(), '/resultados/v1/{id}'] });
  if (request.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
    return json(415, { error: 'Envie multipart/form-data' });
  }
  const lengthHeader = Number(request.headers.get('content-length'));
  if (Number.isFinite(lengthHeader) && lengthHeader > MAX_REQUEST_BYTES) {
    return json(413, { error: 'Requisição acima de 16 MB' });
  }
  let bytes;
  try { bytes = await request.arrayBuffer(); }
  catch { return json(400, { error: 'Corpo da requisição inválido' }); }
  if (bytes.byteLength > MAX_REQUEST_BYTES) return json(413, { error: 'Requisição acima de 16 MB' });
  let form;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type') }, body: bytes }).formData(); }
  catch { return json(400, { error: 'Multipart inválido' }); }
  const files = [...form.entries()].filter(([, value]) => typeof value !== 'string');
  if (files.length !== 1 || files[0][0] !== 'arquivo' || files[0][1].size === 0) {
    return json(400, { error: 'Envie exatamente um arquivo não vazio no campo arquivo' });
  }
  if (files[0][1].size > MAX_FILE_BYTES) return json(413, { error: 'Arquivo acima de 15 MB' });
  if (!validClientId(form.get('clientId')) || !form.get('requestId') || !form.get('policyVersion')) {
    return json(400, { error: 'Informe clientId, requestId e policyVersion' });
  }
  if (form.get('callbackUrl')) return json(400, { error: 'Não envie callbackUrl ao gateway; o resultado será recebido e armazenado pelo próprio Worker' });
  if (!env.RESULTS_BUCKET) return json(503, { error: 'Armazenamento de resultados não configurado' });
  if (url.pathname.includes('/politicas/')) {
    if (!['create', 'update'].includes(form.get('action'))) return json(400, { error: 'action deve ser create ou update' });
    if (files[0][1].type !== 'application/pdf') return json(415, { error: 'Política deve ser PDF' });
  } else {
    const policy = form.get('politicaJson');
    if (typeof policy !== 'string' || !policy.trim()) return json(400, { error: 'Informe politicaJson da versão aprovada' });
    let parsed;
    try {
      parsed = JSON.parse(policy);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('política deve ser objeto');
    } catch {
      return json(400, { error: 'politicaJson deve ser um objeto JSON válido' });
    }
    if (parsed.clientId !== form.get('clientId') || parsed.policyVersion !== form.get('policyVersion') || !Array.isArray(parsed.categorias) || parsed.categorias.length === 0 || !Array.isArray(parsed.regras) || !Array.isArray(parsed.regrasGerais)) {
      return json(400, { error: 'Catálogo da política inválido para este clientId e policyVersion; envie categorias, regras e regrasGerais da versão aprovada' });
    }
  }
  const base = env.N8N_BASE_URL;
  if (!base || !/^https:\/\//.test(base)) return json(503, { error: 'N8N_BASE_URL não configurada' });
  const upstreamUrl = new URL(upstreamPath, base).toString();
  let upstreamContentType;
  let record;
  let resultUrl;
  let resultToken;
  {
    const id = crypto.randomUUID();
    const readToken = token();
    const callbackToken = token();
    const file = files[0][1];
    const fileBytes = await file.arrayBuffer();
    record = {
      id,
      type: url.pathname.includes('/politicas/') ? 'politica' : 'despesa',
      clientId: form.get('clientId'),
      requestId: form.get('requestId'),
      policyVersion: form.get('policyVersion'),
      createdAt: new Date().toISOString(),
      state: 'pending',
      readTokenHash: await sha256(readToken),
      callbackTokenHash: await sha256(callbackToken),
      file: { name: file.name, type: file.type, size: file.size, sha256: await sha256(fileBytes), key: fileKey(id) },
      result: null,
    };
    form.set('callbackUrl', `${url.origin}/callbacks/v1/${id}?token=${callbackToken}`);
    resultUrl = `${url.origin}/resultados/v1/${id}`;
    resultToken = readToken;
    const rebuilt = new Request(request.url, { method: 'POST', body: form });
    upstreamContentType = rebuilt.headers.get('content-type');
    bytes = await rebuilt.arrayBuffer();
    if (bytes.byteLength > MAX_REQUEST_BYTES) return json(413, { error: 'Requisição acima de 16 MB após preparar callback' });
    const uniqueKey = indexKey(await sha256(`${record.type}\0${record.clientId}\0${record.requestId}`));
    let claimed;
    try { claimed = await env.RESULTS_BUCKET.put(uniqueKey, id, { onlyIf: { etagDoesNotMatch: '*' } }); }
    catch { return json(503, { error: 'Não foi possível registrar a solicitação' }); }
    if (claimed === null) return json(409, { error: 'requestId já recebido para este clientId e tipo de fluxo' });
    try {
      await env.RESULTS_BUCKET.put(fileKey(id), fileBytes, { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
      await saveRecord(env.RESULTS_BUCKET, record);
    } catch {
      await Promise.allSettled([env.RESULTS_BUCKET.delete(uniqueKey), env.RESULTS_BUCKET.delete(fileKey(id))]);
      return json(503, { error: 'Não foi possível guardar a solicitação' });
    }
  }
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': upstreamContentType },
      body: bytes,
      redirect: 'manual',
    });
  } catch {
    if (record) await markUpstreamError(env.RESULTS_BUCKET, record.id);
    return json(502, { error: 'Falha ao conectar ao motor n8n' });
  }
  const upstreamText = await upstream.text();
  if (upstream.status !== 202) {
    await markUpstreamError(env.RESULTS_BUCKET, record.id, upstream.status);
    return new Response(upstreamText, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
  }
  let receipt;
  try { receipt = JSON.parse(upstreamText); }
  catch { receipt = { status: 'recebido', respostaMotor: upstreamText }; }
  return json(202, { ...receipt, resultUrl, resultToken });
}

export default { fetch: (request, env) => handleRequest(request, env) };
