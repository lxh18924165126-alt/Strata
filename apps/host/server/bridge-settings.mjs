import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePrivate } from './private-file.mjs';
import { discoverBridge, normalizeBridgeUrl } from './bridge-upstream.mjs';

export function createBridgeSettings({ directory, changed }) {
  const file = join(directory, 'bridge.json');
  let config = { enabled: false, baseUrl: '', apiKey: '', model: null };
  if (existsSync(file)) {
    makePrivate(file);
    config = JSON.parse(readFileSync(file, 'utf8'));
  }
  let status = 'idle', lastError = null;

  function state() {
    const { enabled, baseUrl, apiKey, model } = config;
    return { enabled, baseUrl, apiKeySet: !!apiKey, model, status, error: lastError };
  }

  function connection(error, activeConfig) {
    if (activeConfig !== config) return;
    const next = error ? 'error' : 'connected';
    if (status === next && lastError === error) return;
    status = next;
    lastError = error;
    changed(state());
  }

  async function check(body, blockedPorts) {
    const baseUrl = await normalizeBridgeUrl(body?.baseUrl, blockedPorts);
    const apiKey = (typeof body.apiKey === 'string' && body.apiKey.trim()) || (baseUrl === config.baseUrl ? config.apiKey : '');
    const models = await discoverBridge({ baseUrl, apiKey, blockedPorts });
    return { ...models, apiKey };
  }

  function save(next) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, '', { mode: 0o600, flag: 'wx' });
      makePrivate(temp);
      writeFileSync(temp, JSON.stringify(next));
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    config = next;
    status = next.enabled ? 'connected' : 'idle';
    lastError = null;
    const view = state();
    changed(view);
    return view;
  }

  return { state, config: () => config, check, save, disable: () => save({ ...config, enabled: false }), connection };
}
