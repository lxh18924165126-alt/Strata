import { readBounded } from './bridge-upstream.mjs';
import { json, readBody } from './util.mjs';

const keys = /^\/api\/keys(?:\/(?:usage|[a-f0-9]{32}\/usage))?$/;
const edits = /^\/api\/keys(?:\/[a-f0-9]{32}\/(?:model|quota|state|delete))?$/;

// Forward only to the service selected by the host, with the caller's explicit credential.
export async function serveManagedApi(req, res, url, method, service, fetcher = fetch) {
  const discovery = url.pathname === '/api/upstream' && method === 'GET';
  const fail = (status, message) => json(res, status, { error: discovery ? message : { message } });
  const [, id, path] = /^\/api\/upstream\/([a-f0-9]{32})(\/.*)$/.exec(url.pathname) ?? [];
  const modelList = method === 'GET' && path === '/v1/models';
  if (!discovery && !modelList && !(method === 'GET' && keys.test(path)) && !(method === 'POST' && edits.test(path))) {
    return fail(404, 'Unknown service endpoint.');
  }
  if (!service) {
    return discovery ? json(res, 200, { target: null }) : fail(409, 'The selected service is no longer available.');
  }
  if (!discovery && id !== service.id) return fail(409, 'The selected service changed. Reopen this page.');
  const auth = req.headers.authorization;
  if (!discovery && !modelList && !/^Bearer \S/i.test(auth ?? '')) return fail(401, '需要独立的管理员密钥');
  let body;
  if (method === 'POST') {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return fail(415, 'Send application/json.');
    try { body = JSON.stringify(await readBody(req, 16384)); }
    catch (error) { return fail(400, error.message); }
  }
  try {
    const base = (await service.baseUrl()).slice(0, -3);
    if (!service.current()) return fail(409, 'The selected service changed. Reopen this page.');
    const response = await fetcher(`${base}${discovery ? '/health' : path + url.search}`, {
      method, body, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { accept: 'application/json', ...(!discovery && auth ? { authorization: auth } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return fail(502, 'The selected service returned a redirect.');
    }
    const result = JSON.parse(await readBounded(response));
    if (!service.current()) return fail(409, 'The selected service changed. Reopen this page.');
    if (!discovery) return json(res, response.status, result);
    if (!response.ok || result?.service !== 'strata') return fail(502, 'Could not read Strata service status.');
    return json(res, 200, { target: service.id, base, managed: result.key_management === true });
  } catch {
    return fail(502, 'Could not read the selected Strata service response.');
  }
}
