const ROUTES = new Map([
  ['/webhook/modelo/v1/politicas/processar', '/webhook/modelo/v1/politicas/processar'],
  ['/webhook/modelo/v1/despesas/analisar', '/webhook/modelo/v1/despesas/analisar'],
]);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function validCallback(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return false;
    if (host.includes(':')) return false;
    return true;
  } catch { return false; }
}

function validClientId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(value);
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') {
    return json(200, {
      service: 'motornwork-gateway',
      description: 'Gateway de entrada para o motor n8n. Envie arquivos por POST; o resultado é enviado ao callbackUrl.',
      health: '/health',
      endpoints: [
        { method: 'POST', path: '/webhook/modelo/v1/politicas/processar' },
        { method: 'POST', path: '/webhook/modelo/v1/despesas/analisar' },
      ],
    });
  }
  if (url.pathname === '/health' && request.method === 'GET') {
    return json(200, { status: 'ok', service: 'motornwork-gateway' });
  }
  const upstreamPath = ROUTES.get(url.pathname);
  if (!upstreamPath) return json(404, { error: 'Rota não encontrada', endpoints: ['/', '/health', ...ROUTES.keys()] });
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
  if (!validCallback(form.get('callbackUrl'))) return json(400, { error: 'Informe callbackUrl HTTPS público' });
  if (url.pathname.includes('/politicas/')) {
    if (!['create', 'update'].includes(form.get('action'))) return json(400, { error: 'action deve ser create ou update' });
    if (files[0][1].type !== 'application/pdf') return json(415, { error: 'Política deve ser PDF' });
  } else {
    const policy = form.get('politicaJson');
    if (typeof policy !== 'string' || !policy.trim()) return json(400, { error: 'Informe politicaJson da versão aprovada' });
    try {
      const parsed = JSON.parse(policy);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('política deve ser objeto');
    } catch {
      return json(400, { error: 'politicaJson deve ser um objeto JSON válido' });
    }
  }
  const base = env.N8N_BASE_URL;
  if (!base || !/^https:\/\//.test(base)) return json(503, { error: 'N8N_BASE_URL não configurada' });
  const upstreamUrl = new URL(upstreamPath, base).toString();
  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers: { 'content-type': request.headers.get('content-type') },
      body: bytes,
      redirect: 'manual',
    });
  } catch {
    return json(502, { error: 'Falha ao conectar ao motor n8n' });
  }
  const headers = new Headers();
  headers.set('content-type', upstream.headers.get('content-type') || 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}

export default { fetch: (request, env) => handleRequest(request, env) };
