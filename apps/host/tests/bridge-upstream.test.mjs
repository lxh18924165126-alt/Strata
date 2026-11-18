import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { discoverBridge, forwardBridge, normalizeBridgeUrl } from '../server/bridge-upstream.mjs';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return [server, `http://127.0.0.1:${server.address().port}`];
}
function servingFixture() {
  const row = {};
  return { row, open(value) { Object.assign(row, value); return { id: 'request-1' }; }, mark(id, value) { Object.assign(row, value); }, finish(id, value) { Object.assign(row, value); } };
}

test('discovery normalizes the address, reads model capabilities, and rejects unsafe targets and redirects', async () => {
  const [upstream, root] = await listen((req, res) => {
    assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer secret');
    res.end(JSON.stringify({ data: [{ id: 'm', meta: { n_ctx: 32768 }, architecture: { input_modalities: ['text', 'image'] } }] }));
  });
  try {
    const result = await discoverBridge({ baseUrl: root + '/', apiKey: 'secret' });
    assert.deepEqual(result, { baseUrl: root + '/v1', models: [{ id: 'm', name: 'm', contextMax: 32768, vision: true }] });
    await assert.rejects(normalizeBridgeUrl('http://example.com/v1'), /loopback/);
    await assert.rejects(normalizeBridgeUrl('http://127.example.com/v1'), /loopback/);
    await assert.rejects(normalizeBridgeUrl(root, [upstream.address().port]), /this host/);
    await assert.rejects(discoverBridge({ baseUrl: root, apiKey: 'secret', fetcher: async () => new Response(null, { status: 302 }) }), /redirect/);
    await assert.rejects(discoverBridge({ baseUrl: root, apiKey: 'secret', fetcher: async () => new Response('secret', { status: 401 }) }), /HTTP 401/);
  } finally { upstream.close(); }
});

test('stream preserves SSE, forces the selected model, captures split usage and strips secret from errors', async () => {
  let received;
  const stream = [
    'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}\r\n\r\n',
    'event: error\r\ndata: {"type":"error","error":{"message":"secret"}}\r\n\r\n',
    'event: message_delta\r\ndata: {"type":"message_delta","usage":{"input_tokens":1,"cache_creation_input_tokens":5,"cache_read_input_tokens":4,"output_tokens":3}}\r\n\r\n',
    'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
  ];
  const [upstream, root] = await listen(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    received = { body: JSON.parse(text), headers: req.headers, path: req.url };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const line of stream) { res.write(line.slice(0, 9)); res.write(line.slice(9)); }
    res.end();
  });
  const serving = servingFixture(), connections = [];
  const [gateway, address] = await listen(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    await forwardBridge({ req, res, path: '/v1/messages', body: JSON.parse(text), config: { baseUrl: root, apiKey: 'secret', model: { id: 'remote' } }, serving, onConnection: x => connections.push(x) });
  });
  try {
    const result = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'local', strata_mcp: true, stream: true, messages: [] }) });
    const output = await result.text();
    assert.equal(output, stream.join('').replace('secret', '[redacted]'));
    assert.equal(received.path, '/v1/messages'); assert.equal(received.body.model, 'remote'); assert.equal(received.body.strata_mcp, false);
    assert.equal(received.headers.authorization, 'Bearer secret'); assert.equal(received.headers['anthropic-version'], '2023-06-01');
    assert.equal(serving.row.source, 'bridge'); assert.equal(serving.row.tokensIn, 10); assert.equal(serving.row.tokensOut, 3);
    assert.equal(serving.row.cachedTokens, 4); assert.equal(serving.row.usageIncomplete, false); assert.equal(serving.row.error, 'Bridge returned a stream error.'); assert.deepEqual(connections, [null]);
  } finally { gateway.close(); upstream.close(); }
});

test('JSON usage, count_tokens, and upstream HTTP errors preserve status without exposing the key', async () => {
  const [upstream, root] = await listen(async (req, res) => {
    if (req.url.endsWith('/responses')) res.end(JSON.stringify({ usage: { input_tokens: 21, output_tokens: 4, input_tokens_details: { cached_tokens: 7 } }, timings: { predicted_per_second: 12 } }));
    else if (req.url.endsWith('/count_tokens')) res.end(JSON.stringify({ input_tokens: 9 }));
    else { res.writeHead(401); res.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'bad secret' } })); }
  });
  const records = [], connections = [];
  const [gateway, address] = await listen(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const serving = servingFixture(); records.push(serving.row);
    await forwardBridge({ req, res, path: req.url, body: JSON.parse(text), config: { baseUrl: root, apiKey: 'secret', model: 'remote' }, serving, onConnection: x => connections.push(x) });
  });
  try {
    const call = path => fetch(address + path, { method: 'POST', body: '{}' });
    assert.equal((await call('/v1/responses')).status, 200);
    assert.equal(records[0].tokensIn, 21); assert.equal(records[0].tokensOut, 4); assert.equal(records[0].cachedTokens, 7); assert.equal(records[0].tps, 12);
    assert.equal((await call('/v1/messages/count_tokens')).status, 200); assert.deepEqual(records[1], {});
    const error = await call('/v1/chat/completions'); const payload = await error.text();
    assert.equal(error.status, 401); assert.equal(JSON.parse(payload).error.code, 'invalid_api_key'); assert.ok(!payload.includes('secret')); assert.equal(connections.at(-1), 'Bridge returned HTTP 401.');
  } finally { gateway.close(); upstream.close(); }
});

test('a truncated stream disconnects the client and records partial usage', async () => {
  const [upstream, root] = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {"usage":{"prompt_tokens":7}}\n\n'); });
  const serving = servingFixture();
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/chat/completions', body: { stream: true }, config: { baseUrl: root, apiKey: 'secret', model: 'remote' }, serving }));
  try {
    await assert.rejects(async () => { const response = await fetch(address); await response.text(); });
    assert.equal(serving.row.tokensIn, 7); assert.equal(serving.row.usageIncomplete, true); assert.match(serving.row.error, /before completion/);
  } finally { gateway.close(); upstream.close(); }
});


test('client cancellation stops the upstream request and records partial usage', async () => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const [upstream, root] = await listen((req, res) => {
    res.on('close', upstreamClosed); res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"usage":{"prompt_tokens":6}}\n\n');
  });
  const serving = servingFixture();
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/chat/completions', body: { stream: true }, config: { baseUrl: root, apiKey: 'secret', model: 'remote' }, serving }));
  try {
    const response = await fetch(address), reader = response.body.getReader();
    await reader.read(); await reader.cancel(); await closed;
    assert.equal(serving.row.tokensIn, 6); assert.equal(serving.row.usageIncomplete, true); assert.equal(serving.row.error, 'Request cancelled.');
  } finally { gateway.close(); upstream.close(); }
});


test('discovery validates credentials and model metadata and excludes aliases and image-only models', async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++; assert.ok(options.signal); assert.equal(options.redirect, 'manual');
    return Response.json({ data: [
      { id: 'main', name: 7, meta: { n_ctx: '500', context: 4096 }, architecture: { input_modalities: 'image', output_modalities: ['text'] } },
      { id: 'main' }, { id: 'alias', alias_of: 'main' },
      { id: 'picture', architecture: { output_modalities: ['image'] } },
      { id: 'secret-model' }, { id: 42 },
    ] });
  };
  await assert.rejects(discoverBridge({ baseUrl: 'https://example.com', apiKey: '', fetcher }), /API key/);
  await assert.rejects(discoverBridge({ baseUrl: 'https://example.com/secret', apiKey: 'secret', fetcher }), /must not contain/);
  const result = await discoverBridge({ baseUrl: 'https://example.com', apiKey: 'secret', fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(result.models, [{ id: 'main', name: 'main', contextMax: 4096, vision: null }]);
  await assert.rejects(discoverBridge({ baseUrl: 'https://example.com', apiKey: 'secret', fetcher: async () => new Response('secret', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(discoverBridge({ baseUrl: 'https://example.com', apiKey: 'secret', fetcher: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /Could not read/);
});

test('oversized SSE frames interrupt the response and record an error', async () => {
  const [upstream, root] = await listen((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + 'x'.repeat(2 * 1024 * 1024 + 1)); });
  const serving = servingFixture();
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/chat/completions', body: { stream: true }, config: { baseUrl: root, apiKey: 'secret', model: 'remote' }, serving }));
  try {
    await assert.rejects(async () => { const response = await fetch(address); await response.text(); });
    assert.equal(serving.row.usageIncomplete, true); assert.equal(serving.row.usageSource, 'unavailable'); assert.ok(serving.row.error);
  } finally { gateway.close(); upstream.close(); }
});


test('count_tokens ignores a requested stream and never enters serving', async () => {
  let sent;
  const serving = servingFixture();
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/messages/count_tokens', body: { stream: true }, config: { baseUrl: 'http://localhost:9999', apiKey: 'secret', model: 'm' }, serving,
    fetcher: async (url, options) => { sent = JSON.parse(options.body); return Response.json({ input_tokens: 9 }); } }));
  try {
    const response = await fetch(address);
    assert.deepEqual(await response.json(), { input_tokens: 9 }); assert.equal('stream' in sent, false); assert.deepEqual(serving.row, {});
  } finally { gateway.close(); }
});

test('invalid usage cannot pollute totals and response.failed is a failed terminal event', async () => {
  const serving = servingFixture();
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/responses', body: { stream: true }, config: { baseUrl: 'http://localhost:9999', apiKey: 'secret', model: 'm' }, serving,
    fetcher: async () => new Response('data: {"type":"response.failed","response":{"usage":{"input_tokens":"42","output_tokens":-1,"input_tokens_details":{"cached_tokens":2.5}},"error":{"message":"secret"}},"timings":{"predicted_per_second":"12"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) }));
  try {
    const response = await fetch(address); const text = await response.text();
    assert.ok(!text.includes('secret')); assert.equal(serving.row.tokensIn, null); assert.equal(serving.row.tokensOut, null);
    assert.equal(serving.row.cachedTokens, null); assert.equal(serving.row.tps, null); assert.equal(serving.row.error, 'Bridge returned a stream error.');
  } finally { gateway.close(); }
});

test('invalid upstream address returns a safe gateway error and reports disconnection', async () => {
  const serving = servingFixture(), statuses = [];
  const [gateway, address] = await listen((req, res) => forwardBridge({ req, res, path: '/v1/messages', body: {}, config: { baseUrl: 'http://bad.example', apiKey: 'secret', model: 'm' }, serving, onConnection: x => statuses.push(x) }));
  try {
    const response = await fetch(address); const text = await response.text();
    assert.equal(response.status, 502); assert.equal(JSON.parse(text).type, 'error'); assert.ok(!text.includes('bad.example'));
    assert.deepEqual(statuses, ['Could not complete the bridge request.']);
  } finally { gateway.close(); }
});
