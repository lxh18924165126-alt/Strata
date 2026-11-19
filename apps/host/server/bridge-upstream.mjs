import { once } from 'node:events';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';

const paths = new Set(['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens']);
const MAX_JSON_BYTES = 16 * 1024 * 1024, MAX_EVENT_BYTES = 2 * 1024 * 1024;
const loopback = host => host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));

export async function normalizeBridgeUrl(value, blockedPorts = []) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid bridge address.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid bridge address.');
  if (url.protocol === 'http:' && !loopback(host)) throw new Error('HTTP is only allowed for a loopback tunnel.');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (Array.from(blockedPorts, Number).includes(port)) {
    const local = new Set(['127.0.0.1', '::1', ...Object.values(networkInterfaces()).flatMap(items => (items ?? []).map(x => x.address))]);
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(x => x.address);
    if (host === 'localhost' || addresses.some(address => loopback(address) || local.has(address))) throw new Error('Bridge address points to this host.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, '');
}

export async function readBounded(response, limit = MAX_JSON_BYTES) {
  let size = 0, text = ''; const decoder = new TextDecoder();
  if (response.body) for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Bridge response is too large.');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function discoverBridge({ baseUrl, apiKey, blockedPorts = [], fetcher = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw new Error('A bridge API key is required.');
  const base = await normalizeBridgeUrl(baseUrl, blockedPorts);
  if (base.includes(apiKey) || base.includes(encodeURIComponent(apiKey))) throw new Error('The bridge address must not contain the API key.');
  let response, result;
  try {
    response = await fetcher(`${base}/models`, { headers: { authorization: `Bearer ${apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Bridge redirects are not allowed.'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Bridge model discovery failed (HTTP ${response.status}).`); }
    result = JSON.parse(await readBounded(response, 2 * 1024 * 1024));
  } catch (error) {
    if (error.message === 'Bridge redirects are not allowed.' || /^Bridge model discovery failed \(HTTP \d+\)\.$/.test(error.message)) throw error;
    throw new Error('Could not read the bridge model list.');
  }
  if (!Array.isArray(result?.data)) throw new Error('Bridge returned an invalid model list.');
  const seen = new Set(), models = [];
  for (const m of result.data) {
    if (typeof m?.id !== 'string' || !m.id.trim() || m.id.includes(apiKey) || m.alias_of || seen.has(m.id)) continue;
    const output = m.architecture?.output_modalities;
    if (Array.isArray(output) && output.includes('image') && !output.includes('text')) continue;
    seen.add(m.id);
    const name = [m.name, m.meta?.label, m.id].find(x => typeof x === 'string' && x.trim() && !x.includes(apiKey));
    const contextMax = [m.meta?.n_ctx, m.meta?.context, m.context_length].find(x => Number.isSafeInteger(x) && x > 0) ?? null;
    const input = m.architecture?.input_modalities;
    models.push({ id: m.id, name, contextMax, vision: Array.isArray(input) && input.every(x => typeof x === 'string') ? input.includes('image') : null });
  }
  return { baseUrl: base, models };
}

export async function readBridgeMonitor(config, blockedPorts) {
  const base = await normalizeBridgeUrl(config.baseUrl, blockedPorts);
  const origin = base.slice(0, -3);
  const signal = AbortSignal.timeout(5000);
  let response = await fetch(`${origin}/metrics?requests=all`, {
    headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
    redirect: 'manual', signal,
  });
  // Managed call keys may have no access to /metrics. Strata exposes the
  // same aggregate telemetry to its own dashboard at this fixed path.
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    response = await fetch(`${origin}/api/monitor/metrics?requests=all`, {
      headers: { accept: 'application/json' }, redirect: 'manual', signal,
    });
  }
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const metrics = JSON.parse(await readBounded(response, 2 * 1024 * 1024),
    (_, value) => typeof value === 'string' ? value.replaceAll(config.apiKey, '[redacted]') : value);
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const timestamp = value => Number.isFinite(value) && Math.abs(value) < 8.64e12;
  if (!timestamp(metrics?.time) || !record(metrics.engine) || typeof metrics.engine.model !== 'string' ||
      !record(metrics.live) || typeof metrics.live.state !== 'string' ||
      !record(metrics.hardware) || !record(metrics.hardware_static) || !record(metrics.history) ||
      !record(metrics.totals) || !timestamp(metrics.totals.since) || !Array.isArray(metrics.requests) ||
      !metrics.requests.every(row => timestamp(row?.time)) ||
      (metrics.hardware.gpus != null && (!Array.isArray(metrics.hardware.gpus) ||
        !metrics.hardware.gpus.every(gpu => Number.isSafeInteger(gpu?.index))))) return null;
  // Engine metadata can include paths and diagnostics. Send the fields used by the monitor.
  const { model, max_context, expert_slots, experts, expert_cache_mib } = metrics.engine;
  const { time, live, hardware, hardware_static, history, totals, requests, conversation_cache } = metrics;
  return { time, live, hardware, hardware_static, history, totals, requests, conversation_cache,
    engine: { model, max_context, expert_slots, experts, expert_cache_mib } };
}

export async function forwardBridge({ req, res, path, body, config, serving, onConnection, client, fetcher = fetch }) {
  if (!paths.has(path)) throw new Error('Unsupported bridge endpoint.');
  let base;
  try { base = await normalizeBridgeUrl(config.baseUrl, config.blockedPorts ?? []); }
  catch {
    if (!res.destroyed) {
      const message = 'Could not complete the bridge request.'; onConnection?.(message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...(path.startsWith('/v1/messages') ? { type: 'error' } : {}), error: { message, type: path.startsWith('/v1/messages') ? 'api_error' : 'server_error' } }));
    }
    return;
  }
  if (res.destroyed) return;
  const countOnly = path.endsWith('/count_tokens'), streaming = !countOnly && body.stream === true;
  const abort = new AbortController(), started = Date.now();
  let terminal = false, streamError = false, tokensIn = null, tokensOut = null, cachedTokens = null, tps = null, promptTps = null;
  const close = () => { if (!res.writableEnded && !terminal) abort.abort(); };
  res.on('close', close);
  const entry = countOnly ? null : serving.open({ client: client ?? req.headers['user-agent']?.slice(0, 100) ?? 'API client', endpoint: path.slice(3), model: typeof config.model === 'string' ? config.model : config.model.id, source: 'bridge', cancel: () => abort.abort() });
  const observe = value => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'error' || value.type === 'response.failed' || value.error || value.response?.error) streamError = true;
    if (['response.completed', 'response.incomplete', 'response.failed', 'message_stop'].includes(value.type)) terminal = true;
    const count = n => Number.isSafeInteger(n) && n >= 0;
    for (const usage of [value.message?.usage, value.usage, value.response?.usage]) {
      if (!usage) continue;
      const input = usage.prompt_tokens ?? usage.input_tokens;
      const creation = usage.cache_creation_input_tokens, read = usage.cache_read_input_tokens;
      if (count(input)) {
        const total = input + (count(creation) ? creation : 0) + (count(read) ? read : 0);
        if (count(total)) tokensIn = total;
      }
      const output = usage.completion_tokens ?? usage.output_tokens;
      if (count(output)) tokensOut = output;
      const cache = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? read;
      if (count(cache)) cachedTokens = cache;
    }
    const timing = value.timings ?? value.response?.timings;
    if (timing) {
      if (Number.isFinite(timing.predicted_per_second) && timing.predicted_per_second >= 0) tps = timing.predicted_per_second;
      if (Number.isFinite(timing.prompt_per_second) && timing.prompt_per_second >= 0) promptTps = timing.prompt_per_second;
    }
  };
  const mark = () => entry && serving.mark(entry.id, { tokensIn, tokensOut, cachedTokens, tps, promptTps, usageSource: tokensIn === null && tokensOut === null ? 'unavailable' : 'reported', usageIncomplete: (streaming && !terminal) || tokensIn === null || tokensOut === null || cachedTokens === null });
  const finish = error => { if (!entry) return; mark(); serving.finish(entry.id, { tokensOut, durationMs: Date.now() - started, ...(error ? { error } : {}) }); };
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
    for (const h of ['anthropic-version', 'anthropic-beta']) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];
    const upstreamBody = { ...body, model: typeof config.model === 'string' ? config.model : config.model.id, strata_mcp: false };
    if (countOnly) delete upstreamBody.stream;
    const response = await fetcher(`${base}${path.slice(3)}`, { method: 'POST', headers, redirect: 'manual', signal: abort.signal, body: JSON.stringify(upstreamBody) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error('Bridge redirects are not allowed.'); }
    if (response.status === 401 || response.status === 403 || response.status >= 500) onConnection?.(`Bridge returned HTTP ${response.status}.`);
    else if (response.ok) onConnection?.(null);
    if (!response.ok) {
      let code = null;
      try { const data = JSON.parse(await readBounded(response, 1024 * 1024)); const candidate = data?.error?.code; if (typeof candidate === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(candidate) && !candidate.includes(config.apiKey)) code = candidate; } catch { /* The status is sufficient when the upstream error is not JSON. */ }
      finish(`Bridge returned HTTP ${response.status}.`);
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...(path.startsWith('/v1/messages') ? { type: 'error' } : {}), error: { message: `Bridge returned HTTP ${response.status}.`, type: path.startsWith('/v1/messages') ? 'api_error' : 'server_error', code } }));
      return;
    }
    if (entry) serving.mark(entry.id, { state: 'generating' });
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-cache', ...(entry ? { 'x-strata-request-id': entry.id } : {}), 'x-accel-buffering': 'no' });
    if (streaming) {
      let pending = ''; const decoder = new TextDecoder();
      const flush = async text => {
        pending += text;
        let end;
        while ((end = pending.search(/\r?\n\r?\n/)) >= 0) {
          let event = pending.slice(0, end);
          if (Buffer.byteLength(event) > MAX_EVENT_BYTES) throw new Error('Bridge stream event is too large.');
          const separator = pending.slice(end).match(/^\r?\n\r?\n/)[0];
          pending = pending.slice(end + separator.length);
          const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          const errorEvent = event.split(/\r?\n/).some(line => /^event: *error *$/.test(line));
          if (errorEvent) streamError = true;
          if (data === '[DONE]') terminal = true;
          else if (data) {
            let value;
            try { value = JSON.parse(data); observe(value); } catch { /* Non-JSON SSE events have no usage. */ }
            if ((errorEvent || value?.type === 'error' || value?.type === 'response.failed' || value?.error || value?.response?.error) && config.apiKey) {
              if (value !== undefined) {
                const safe = JSON.stringify(value).replaceAll(JSON.stringify(config.apiKey).slice(1, -1), '[redacted]');
                const lines = event.split(/\r?\n/), first = lines.findIndex(line => line.startsWith('data:'));
                event = lines.filter(line => !line.startsWith('data:')).toSpliced(first, 0, `data: ${safe}`).join(separator.startsWith('\r') ? '\r\n' : '\n');
              } else event = event.replaceAll(config.apiKey, '[redacted]');
            }
          }
          if (!res.destroyed && !res.write(event + separator)) await once(res, 'drain', { signal: abort.signal });
        }
        if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) throw new Error('Bridge stream event is too large.');
      };
      for await (const chunk of response.body) await flush(decoder.decode(chunk, { stream: true }));
      await flush(decoder.decode());
      if (!terminal) throw new Error('Bridge stream ended before completion.');
    } else {
      const text = await readBounded(response);
      let output = text;
      try { const value = JSON.parse(text); observe(value); if (value.error && config.apiKey) output = JSON.stringify(value).replaceAll(JSON.stringify(config.apiKey).slice(1, -1), '[redacted]'); } catch { /* Pass through a non-JSON response unchanged. */ }
      res.write(output);
    }
    finish(streamError ? 'Bridge returned a stream error.' : undefined); res.end();
  } catch (error) {
    const message = abort.signal.aborted ? 'Request cancelled.' : error.message === 'Bridge redirects are not allowed.' || error.message === 'Bridge stream ended before completion.' ? error.message : 'Could not complete the bridge request.';
    if (!abort.signal.aborted) onConnection?.(message);
    finish(message);
    if (!res.headersSent && !res.destroyed) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'server_error' } })); }
    else if (!res.destroyed) res.destroy();
  } finally { res.off('close', close); }
}
