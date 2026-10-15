import { metrics, tryIndex, indexRecord, listRequests, report } from './catalog.js';
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

async function saveRecord(bucket, record, db) {
  record.revision = (record.revision ?? 0) + 1;
  const saved = await bucket.put(recordKey(record.id), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' },
    ...(record._etag ? { onlyIf: { etagMatches: record._etag } } : {}),
  });
  if (saved === null) throw new Error('Registro alterado por outra execução');
  await tryIndex(db, record);
}

async function markUpstreamError(bucket, id, status, db) {
  try {
    const latest = await loadRecord(bucket, id);
    if (!latest || latest.state !== 'pending') return;
    latest.state = 'upstream_error';
    if (status) latest.upstreamStatus = status;
    await saveRecord(bucket, latest, db);
  } catch { /* preserve the original error response */ }
}

function publicRecord(record) {
  const { readTokenHash, callbackTokenHash, deliveryUrl, ...visible } = record;
  return visible;
}

// Delivery is independent of OCR: failures preserve the complete stored result.
async function deliverResult(bucket, id, env, fetchImpl) {
  const record = await loadRecord(bucket, id);
  if (!record.deliveryUrl || record.delivery?.state === 'delivered') return true;
  if (record.delivery?.state === 'sending' && Date.now() - Date.parse(record.delivery.attemptedAt) < 30000) return false;
  record.delivery = { state: 'sending', attempts: (record.delivery?.attempts || 0) + 1, attemptedAt: new Date().toISOString() };
  try { await saveRecord(bucket, record, env.INDEX_DB); } catch { return false; }
  let status = null;
  try {
    const headers = { 'content-type': 'application/json', 'Idempotency-Key': record.id };
    if (env.CLIENT_CALLBACK_TOKEN) headers.Authorization = `Bearer ${env.CLIENT_CALLBACK_TOKEN}`;
    const response = await fetchImpl(record.deliveryUrl, {
      method: 'POST', headers, body: JSON.stringify(record.result), redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    status = response.status;
    if (response.body) await response.body.cancel();
  } catch { /* No secrets, URLs or response bodies in error records. */ }
  const latest = await loadRecord(bucket, id);
  latest.delivery = { ...record.delivery, state: status >= 200 && status < 300 ? 'delivered' : 'failed', httpStatus: status, finishedAt: new Date().toISOString() };
  await saveRecord(bucket, latest, env.INDEX_DB);
  return latest.delivery.state === 'delivered';
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

// The integration token authenticates the transactional system, not an individual company.
// clientId is canonical decimal text, inclusive range 100..1000.
function allowedClientId(value) {
  return typeof value === 'string' && /^(?:[1-9][0-9]{2}|1000)$/.test(value);
}
async function authenticateEntry(request, env) {
  if (!/^[a-f0-9]{64}$/.test(env.INTEGRATION_TOKEN_SHA256 ?? '') ||
      typeof env.N8N_WEBHOOK_SECRET !== 'string' || env.N8N_WEBHOOK_SECRET.length < 32) {
    return { response: json(503, { error: 'Autenticação da integração não configurada' }) };
  }
  const supplied = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  if (!supplied || !equalHash(await sha256(supplied), env.INTEGRATION_TOKEN_SHA256)) {
    return { response: json(401, { error: 'Token de integração ausente ou inválido' }) };
  }
  return {};
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
  if (url.pathname.startsWith('/api/v1/')) return handleCatalog(request, env, url);
  const resultMatch = url.pathname.match(/^\/resultados\/v1\/([0-9a-f-]{36})(\/reenviar)?$/);
  if (resultMatch) {
    if (request.method !== (resultMatch[2] ? 'POST' : 'GET')) return json(405, { error: resultMatch[2] ? 'Use POST' : 'Use GET' });
    if (!env.RESULTS_BUCKET) return json(503, { error: 'Armazenamento de resultados não configurado' });
    const supplied = request.headers.get('authorization')?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (!supplied) return json(404, { error: 'Resultado não encontrado' });
    const record = await loadRecord(env.RESULTS_BUCKET, resultMatch[1]);
    if (!record || !equalHash(await sha256(supplied), record.readTokenHash)) return json(404, { error: 'Resultado não encontrado' });
    if (resultMatch[2]) {
      if (record.state !== 'completed' || !record.deliveryUrl) return json(409, { error: 'Resultado ou destino de entrega indisponível' });
      const delivered = await deliverResult(env.RESULTS_BUCKET, record.id, env, fetchImpl);
      return json(delivered ? 200 : 502, { status: delivered ? 'entregue' : 'entrega_pendente' });
    }
    await tryIndex(env.INDEX_DB, record);
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
      await tryIndex(env.INDEX_DB, record);
      if (!equalHash(record.resultSha256, digest)) return json(409, { error: 'Resultado diferente já armazenado' });
      const delivered = await deliverResult(env.RESULTS_BUCKET, record.id, env, fetchImpl);
      return json(delivered ? 200 : 502, { status: delivered ? 'ja_recebido' : 'armazenado_entrega_pendente' });
    }
    record.state = 'completed';
    record.completedAt = new Date().toISOString();
    record.resultSha256 = digest;
    record.result = result;
    record.resultKey = `results/${record.id}/${digest}.json`;
    await env.RESULTS_BUCKET.put(record.resultKey, bytes, { httpMetadata: { contentType: 'application/json' } });
    try { await saveRecord(env.RESULTS_BUCKET, record, env.INDEX_DB); }
    catch {
      const latest = await loadRecord(env.RESULTS_BUCKET, callbackMatch[1]);
      return latest?.state === 'completed' && equalHash(latest.resultSha256, digest)
        ? json(200, { status: 'ja_recebido' })
        : json(409, { error: 'Resultado diferente já armazenado' });
    }
    const delivered = await deliverResult(env.RESULTS_BUCKET, record.id, env, fetchImpl);
    return json(delivered ? 200 : 502, { status: delivered ? 'armazenado' : 'armazenado_entrega_pendente', requestId: record.requestId });
  }
  const upstreamPath = ROUTES.get(url.pathname);
  if (!upstreamPath) return json(404, { error: 'Rota não encontrada', endpoints: ['/', '/health', ...ROUTES.keys(), '/resultados/v1/{id}'] });
  if (request.method !== 'POST') return json(405, { error: 'Use POST' });
  const entryAuth = await authenticateEntry(request, env);
  if (entryAuth.response) return entryAuth.response;
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
  if (!allowedClientId(form.get('clientId'))) return json(403, { error: 'clientId deve ser texto numérico de 100 a 1000, sem zeros à esquerda' });
  let deliveryUrl = null;
  if (env.CLIENT_CALLBACK_URL) {
    try {
      const target = new URL(env.CLIENT_CALLBACK_URL);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error();
      deliveryUrl = target.toString();
    } catch { return json(503, { error: 'Destino de retorno inválido na configuração' }); }
  }
  if (form.get('callbackUrl') && form.get('callbackUrl') !== deliveryUrl) return json(400, { error: 'callbackUrl deve corresponder ao destino configurado da integração' });
  if (form.has('vendedorId') && (typeof form.get('vendedorId') !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(form.get('vendedorId')))) return json(400, { error: 'vendedorId inválido' });
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
      vendedorId: form.get('vendedorId') || null,
      entrada: Object.fromEntries([...form.entries()].filter(([key,value]) => typeof value === 'string' && key !== 'callbackUrl')),
      createdAt: new Date().toISOString(),
      state: 'pending',
      deliveryUrl,
      delivery: { state: deliveryUrl ? 'waiting_result' : 'not_configured', attempts: 0 },
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
      await saveRecord(env.RESULTS_BUCKET, record, env.INDEX_DB);
    } catch {
      await Promise.allSettled([env.RESULTS_BUCKET.delete(uniqueKey), env.RESULTS_BUCKET.delete(fileKey(id))]);
      return json(503, { error: 'Não foi possível guardar a solicitação' });
    }
  }
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': upstreamContentType, 'X-Motor-Secret': env.N8N_WEBHOOK_SECRET },
      body: bytes,
      redirect: 'manual',
    });
  } catch {
    if (record) await markUpstreamError(env.RESULTS_BUCKET, record.id, null, env.INDEX_DB);
    return json(502, { error: 'Falha ao conectar ao motor n8n' });
  }
  const upstreamText = await upstream.text();
  if (upstream.status !== 202) {
    await markUpstreamError(env.RESULTS_BUCKET, record.id, upstream.status, env.INDEX_DB);
    return new Response(upstreamText, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
  }
  let receipt;
  try { receipt = JSON.parse(upstreamText); }
  catch { receipt = { status: 'recebido', respostaMotor: upstreamText }; }
  return json(202, { ...receipt, id: record.id, clientId: record.clientId, requestId: record.requestId, policyVersion: record.policyVersion, resultUrl, resultToken });
}

export default { fetch: (request, env) => handleRequest(request, env) };

async function handleCatalog(request,env,url) {
 const auth=await authenticateEntry(request,env);if(auth.response)return auth.response;
 if(!env.RESULTS_BUCKET)return json(503,{error:'R2 não configurado'});
 if(url.pathname==='/api/v1/indice/reconstruir'){
  if(request.method!=='POST')return json(405,{error:'Use POST'});
  if(!env.INDEX_DB)return json(503,{error:'Índice D1 não configurado'});
  const page=await env.RESULTS_BUCKET.list({prefix:'requests/',limit:100,...(url.searchParams.get('cursor')?{cursor:url.searchParams.get('cursor')}: {})});
  let indexed=0;const failed=[];
  for(const object of page.objects){
   try{const stored=await env.RESULTS_BUCKET.get(object.key);if(!stored)continue;await indexRecord(env.INDEX_DB,JSON.parse(await stored.text()));indexed++;}
   catch{failed.push(object.key);}
  }
  return json(200,{indexed,failed,nextCursor:page.truncated?page.cursor:null});
 }
 if(request.method!=='GET')return json(405,{error:'Use GET'});
 const clientId=url.searchParams.get('clientId');
 if(!allowedClientId(clientId))return json(400,{error:'Informe clientId de 100 a 1000'});
 const match=url.pathname.match(/^\/api\/v1\/solicitacoes\/([0-9a-f-]{36})(?:\/(arquivo|medicao|resultado-original))?$/);
 if(match){
  const r=await loadRecord(env.RESULTS_BUCKET,match[1]);
  if(!r||r.clientId!==clientId)return json(404,{error:'Solicitação não encontrada'});
  await tryIndex(env.INDEX_DB,r);
  if(match[2]==='resultado-original'){
   if(!r.resultKey)return json(404,{error:'Bytes originais do callback não disponíveis neste registro; consulte result'});
   const raw=await env.RESULTS_BUCKET.get(r.resultKey);if(!raw)return json(404,{error:'Resultado original não encontrado'});
   return new Response(raw.body,{headers:{'content-type':'application/json','cache-control':'no-store'}});
  }
  if(match[2]==='arquivo'){
   const file=await env.RESULTS_BUCKET.get(r.file.key);if(!file)return json(404,{error:'Arquivo não encontrado'});
   return new Response(file.body,{headers:{'content-type':r.file.type||'application/octet-stream',
    'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(r.file.name).replace(/'/g,'%27')}`,
    'cache-control':'no-store','x-content-type-options':'nosniff'}});
  }
  if(match[2]==='medicao')return json(200,{id:r.id,clientId:r.clientId,requestId:r.requestId,state:r.state,...metrics(r)});
  return json(r.state==='pending'?202:200,publicRecord(r));
 }
 if(!['/api/v1/solicitacoes','/api/v1/relatorios/processamento'].includes(url.pathname))return json(404,{error:'Rota não encontrada'});
 if(!env.INDEX_DB)return json(503,{error:'Índice D1 não configurado'});
 try{
  // Parse client filters separately so database failures are not reported as user errors.
  if(url.pathname==='/api/v1/solicitacoes')return json(200,await listRequests(env.INDEX_DB,url.searchParams));
  return json(200,await report(env.INDEX_DB,url.searchParams));
 }catch(e){
  const validation=/^(Filtro |from|limit |Cursor )/.test(e.message);
  return json(validation?400:503,{error:validation?e.message:'Índice temporariamente indisponível; use a consulta individual no R2'});
 }
}
