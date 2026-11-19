/**
 * Anthropic clients add `/v1/messages` to the base URL themselves, so the base URL they are given is the server root (no `/v1`).
 * A base URL copied from an OpenAI-style setup ends in `/v1`, and the client then posts `/v1/v1/messages`. That one path means the
 * same as the real one; nothing else is aliased (an OpenAI client never adds `/v1` on its own).
 */
const ALIASES = new Map([['/v1/v1/messages', '/v1/messages'], ['/v1/v1/messages/count_tokens', '/v1/messages/count_tokens']]);
export const PUBLIC_MODEL = 'yuxi-v1';
export const MODEL_IDENTITY = 'You are yuxi-v1.';

export function withModelAlias(models, selected) {
  if (!selected || models.some(model => model.id === PUBLIC_MODEL)) return models;
  return [...models, { ...selected, id: PUBLIC_MODEL, alias_of: selected.id }];
}

function withIdentityText(value, partType = 'text') {
  if (Array.isArray(value)) {
    if (value.some(part => hasIdentity(typeof part === 'string' ? part : part?.text))) return value;
    return [...value, { type: partType, text: `\n\n${MODEL_IDENTITY}` }];
  }
  if (value == null || value === '') return MODEL_IDENTITY;
  if (typeof value !== 'string' || hasIdentity(value)) return value;
  return `${value}\n\n${MODEL_IDENTITY}`;
}

function hasIdentity(value) {
  return typeof value === 'string' && value.split('\n\n').some(text => text.trim() === MODEL_IDENTITY);
}

export function withModelIdentity(path, body) {
  if (path === '/v1/responses') return { ...body, instructions: withIdentityText(body.instructions, 'input_text') };
  if (path.startsWith('/v1/messages')) return { ...body, system: withIdentityText(body.system) };

  let messages = body.messages;
  if (typeof messages === 'string') {
    try { messages = JSON.parse(messages); }
    catch (error) { if (error instanceof SyntaxError) return body; throw error; }
  }
  if (!Array.isArray(messages) || !messages.length) return body;
  const [first, ...rest] = messages;
  if (first?.role === 'system' || first?.role === 'developer') {
    return { ...body, messages: [{ ...first, content: withIdentityText(first.content) }, ...rest] };
  }
  return { ...body, messages: [{ role: 'system', content: MODEL_IDENTITY }, ...messages] };
}

export function apiPath(path) {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return ALIASES.get(clean) ?? path;
}

