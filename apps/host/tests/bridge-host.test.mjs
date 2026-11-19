import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function startHost(home, base, localService) {
  if (!base) {
    const probe = createServer();
    base = await listen(probe);
    await close(probe);
  }
  const env = {
    ...process.env, STRATA_HOME: home, STRATA_MODELS_DIR: join(home, 'models'), STRATA_WORKSPACE: join(home, 'workspace'),
    STRATA_COMPONENTS_DIR: join(home, 'components'), STRATA_SETTINGS_FILE: join(home, 'app-settings.json'),
    STRATA_BIND: '127.0.0.1', STRATA_PORT: new URL(base).port, STRATA_REAL_ENGINE: '1', STRATA_AGENT: 'off',
    STRATA_NO_REPAIR_ACCESS: '1', LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'),
    XDG_DATA_HOME: join(home, 'xdg-data'), XDG_STATE_HOME: join(home, 'xdg-state'), XDG_CONFIG_HOME: join(home, 'xdg-config'),
    ...(localService ? { STRATA_SERVER_URL: localService } : {}),
  };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'server', 'index.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let log = '';
  child.stdout.on('data', data => { log += data; });
  child.stderr.on('data', data => { log += data; });
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  const call = (path, { method = 'GET', body, headers, signal } = {}) => fetch(`${base}${path}`, {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  for (let i = 0; i < 160 && child.exitCode === null; i++) {
    try { if ((await call('/api/health')).ok) return { base, call, stop, log: () => log }; } catch { /* The process is still starting. */ }
    await delay(100);
  }
  await stop();
  throw new Error(`Host did not start. ${log}`);
}

test('bridge mode routes desktop and local API calls, keeps only A usage and restores without a local engine', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'strata-bridge-host-'));
  const keyB = 'sk-test-bridge-upstream-only', keyA = 'sk-test-local';
  const model = 'qwen-on-b';
  const usage = { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } };
  const calls = [];
  let cancelled = false;
  let monitorResponse;
  let managedMonitor = false;
  const remote = createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/api/monitor/metrics?requests=all' && managedMonitor) {
      assert.equal(req.headers.authorization, undefined);
      return monitorResponse(res, json);
    }
    if (req.headers.authorization !== `Bearer ${keyB}`) return json({ error: { message: 'Invalid key' } }, 401);
    if (req.url === '/v1/models') return json({ data: [{ id: model, meta: { n_ctx: 64000 }, architecture: { input_modalities: ['text'] } }] });
    if (req.url === '/metrics?requests=all') return managedMonitor ? json({ error: { message: 'Telemetry key required' } }, 401) : monitorResponse(res, json);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body);
    if (req.url.endsWith('/count_tokens')) return json({ input_tokens: 12 });
    if (req.url === '/v1/messages') return json({ usage: { input_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 4, output_tokens: 3 } });
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } } })}\n\n`);
    }
    if (body.input === 'quota') return json({ error: { message: `Quota for ${keyB}`, code: 'insufficient_quota' } }, 429);
    if (!body.stream) return json({ usage });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const draft = body.messages?.at(-1)?.content?.includes('Draft a recurring prompt task');
    const text = draft ? JSON.stringify({ title: 'Draft from B' }) : 'Reply from B';
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }], usage })}\n\n`);
    if (body.input === 'hold') { res.on('close', () => { cancelled = !res.writableEnded; }); return; }
    res.end('data: [DONE]\n\n');
  });
  const remoteUrl = await listen(remote);
  let localCalls = 0;
  const local = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ service: 'strata', model: 'local-model' }));
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    if (req.headers.authorization !== `Bearer ${keyA}`) { res.writeHead(401); return res.end(); }
    localCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    return res.end('data: {"choices":[{"delta":{"content":"Reply from local API"}}]}\n\ndata: [DONE]\n\n');
  });
  const localUrl = await listen(local);
  let host;
  t.after(async () => { await host?.stop(); await Promise.all([close(local), close(remote)]); await rm(home, { recursive: true, force: true, maxRetries: 3 }); });
  host = await startHost(home, undefined, localUrl);
  const patch = (path, body) => host.call(path, { method: 'PATCH', body });
  const post = (path, body, headers, signal) => host.call(path, { method: 'POST', body, headers, signal });
  const get = async path => (await host.call(path)).json();
  const authA = { authorization: `Bearer ${keyA}` };
  assert.equal((await get('/api/bridge')).enabled, false);
  assert.deepEqual(await get('/api/upstream'), { target: null });
  const pairedOrigin = { origin: localUrl };
  const fromLocalPage = () => post('/api/chat/stream', { message: 'Hello' }, { ...pairedOrigin, ...authA });
  assert.match(await (await fromLocalPage()).text(), /Reply from local API/);
  const fromLocalhost = await post('/api/chat/stream', { message: 'Hello' },
    { ...authA, origin: localUrl.replace('127.0.0.1', 'localhost') });
  assert.match(await fromLocalhost.text(), /Reply from local API/);
  assert.equal((await host.call('/api/bridge/monitor')).status, 409);
  assert.equal((await post('/api/bridge/test', { baseUrl: host.base, apiKey: keyB })).status, 400);
  assert.equal((await post('/api/bridge/test', { baseUrl: remoteUrl, apiKey: 'bad-key' })).status, 400);
  const discovered = await (await post('/api/bridge/test', { baseUrl: remoteUrl, apiKey: keyB })).json();
  assert.deepEqual(discovered.models, [{ id: model, name: model, contextMax: 64000, vision: false }]);
  assert.equal((await patch('/api/serving', { apiKey: keyA })).status, 200);
  const enabled = await (await patch('/api/bridge', { enabled: true, baseUrl: remoteUrl, apiKey: keyB, modelId: model })).json();
  assert.equal(enabled.enabled, true, JSON.stringify(enabled));
  assert.equal(enabled.apiKeySet, true);
  assert.ok(!JSON.stringify(enabled).includes(keyB));
  assert.deepEqual(await get('/api/upstream'), { target: null });
  assert.equal((await host.call(`/api/upstream/${'0'.repeat(32)}/api/keys`, { headers: authA })).status, 409);
  const pairedChat = await post('/api/chat/stream', { message: 'Hello' }, pairedOrigin);
  assert.match(await pairedChat.text(), /本机服务的调用 Key/);
  assert.match(await (await fromLocalPage()).text(), /Reply from local API/);
  assert.equal(localCalls, 3);
  assert.equal(calls.length, 0);
  monitorResponse = (_res, json) => json({
    time: 100, engine: { model, path: 'private/engine/config' }, live: { state: 'generating', tok_s: 31 },
    hardware: { cpu: 86, ram_total: 128 * 1024 ** 3 }, hardware_static: { cpu_name: 'Remote CPU' },
    history: { cpu: [84, 86] }, totals: { since: 10, requests: 48 },
    requests: [{ id: 'remote-request', time: 92, output_tokens: 71, diagnostic: keyB }],
  });
  const snapshot = await get('/api/bridge/monitor');
  managedMonitor = true;
  assert.deepEqual(await get('/api/bridge/monitor'), snapshot);
  managedMonitor = false;
  assert.equal(snapshot.hardware.cpu, 86);
  assert.equal(snapshot.live.tok_s, 31);
  assert.equal(snapshot.totals.requests, 48);
  assert.equal(snapshot.requests[0].id, 'remote-request');
  assert.ok(!JSON.stringify(snapshot).includes(keyB));
  assert.ok(!JSON.stringify(snapshot).includes('private/engine/config'));
  monitorResponse = (res) => { res.writeHead(302, { location: '/v1/models' }); return res.end(); };
  assert.equal((await host.call('/api/bridge/monitor')).status, 502);
  monitorResponse = (_res, json) => json({ data: [] });
  assert.equal((await host.call('/api/bridge/monitor')).status, 502);
  assert.equal((await post('/api/bridge/test', { baseUrl: enabled.baseUrl })).status, 200, 'saved key can be reused');
  assert.equal((await post('/api/runtime/load', {})).status, 409);
  assert.equal((await post('/api/native/operations', { kind: 'load' })).status, 409);
  assert.equal((await post('/api/native/operations', { kind: 'install', args: { loadAfter: true } })).status, 409);
  assert.equal((await post('/api/serving/share', { enabled: true })).status, 409);
  assert.equal((await post('/api/internal/bridge/agent/v1/chat/completions', {})).status, 403);
  assert.equal((await host.call('/v1/models', { headers: { ...authA, origin: 'https://other.example' } })).status, 403);
  assert.equal((await host.call('/v1/models')).status, 401);
  const listed = (await (await host.call('/v1/models', { headers: authA })).json()).data;
  assert.deepEqual(listed.map(item => item.id), [model, 'yuxi-v1']);
  assert.equal(listed[1].alias_of, model);

  const desktop = await post('/api/chat/stream', { message: 'Hello', remoteModel: { connectionId: 'old-model', modelId: 'old-id' } });
  const frames = (await desktop.text()).trim().split('\n').map(JSON.parse);
  assert.equal(frames.find(f => f.type === 'delta')?.text, 'Reply from B');
  assert.equal(frames.find(f => f.type === 'done')?.tokensIn, 12);
  const draft = await (await post('/api/tasks/draft', { description: 'Send a weekly summary' })).json();
  assert.equal(draft.draft.title, 'Draft from B');
  const system = [{ type: 'text', text: 'Keep answers short.', cache_control: { type: 'ephemeral' } }];
  assert.equal((await post('/v1/v1/messages/count_tokens', { model: 'yuxi-v1', system }, authA)).status, 200);
  assert.equal((await post('/v1/messages', { model, system }, authA)).status, 200);
  assert.deepEqual(calls.at(-2).system, [...system, { type: 'text', text: '\n\nYou are yuxi-v1.' }]);
  assert.deepEqual(calls.at(-1).system, calls.at(-2).system);
  assert.match(await (await post('/v1/responses', { model: 'yuxi-v1', instructions: 'Keep answers short.', stream: true }, authA)).text(), /response\.completed/);
  assert.equal(calls.at(-1).instructions, 'Keep answers short.\n\nYou are yuxi-v1.');
  await (await fetch(`${remoteUrl}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${keyB}` }, body: JSON.stringify({ model }) })).text();
  const serving = await get('/api/serving');
  assert.deepEqual(serving.bridgeTotals, { requests: 4, completed: 4, failed: 0, tokensIn: 48, tokensOut: 12, cachedTokens: 16, incomplete: 0 });
  assert.ok(serving.requests.every(r => r.source === 'bridge' && r.model === model));
  assert.ok(calls.every(call => call.model === model));

  const messages = [{ role: 'user', content: 'Hello' }];
  const quota = await post('/v1/chat/completions', { model: 'yuxi-v1', messages, input: 'quota' }, authA);
  assert.equal(quota.status, 429);
  assert.deepEqual(calls.at(-1).messages, [{ role: 'system', content: 'You are yuxi-v1.' }, ...messages]);
  const quotaText = await quota.text();
  assert.match(quotaText, /insufficient_quota/);
  assert.ok(!quotaText.includes(keyB));
  const signal = new AbortController();
  const held = await post('/v1/chat/completions', { stream: true, input: 'hold' }, authA, signal.signal);
  assert.equal(held.status, 200);
  await held.body.getReader().read();
  assert.equal((await patch('/api/bridge', { enabled: false })).status, 409);
  signal.abort();
  for (let i = 0; i < 50 && !cancelled; i++) await delay(20);
  assert.equal(cancelled, true);
  const partial = (await get('/api/serving')).requests[0];
  assert.equal(partial.usageIncomplete, true);
  assert.equal(partial.tokensIn, 12);

  await host.stop();
  host = await startHost(home, host.base);
  assert.equal((await get('/api/bridge')).enabled, true);
  assert.equal((await get('/api/health')).engine.pid, null);
  assert.equal((await get('/api/serving')).bridgeTotals.requests, 0);
  await close(remote);
  const lost = await post('/v1/chat/completions', {}, authA);
  assert.equal(lost.status, 502);
  assert.equal((await get('/api/bridge')).status, 'error');
  assert.equal((await get('/api/health')).engine.pid, null);
  assert.equal((await (await patch('/api/bridge', { enabled: false })).json()).enabled, false);
  assert.deepEqual((await (await host.call('/v1/models', { headers: authA })).json()).data, []);
  assert.ok(!host.log().includes(keyB));
});
