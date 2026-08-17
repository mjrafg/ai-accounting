/**
 * Provider envelope inspection and structured extraction.
 *
 * Carried from V1 because it was earned the hard way: the transport envelope is
 * read BEFORE any attempt to find JSON in it. A Claude CLI 401 arrives inside a
 * perfectly valid envelope (is_error:true, subtype confusingly "success") and
 * must classify as AGENT_EXECUTION_ERROR/AUTH — never "no JSON object found".
 * A 429 must become RATE_LIMIT even when the process exits 0.
 */

export type FailureKind = 'AGENT_EXECUTION_ERROR' | 'ADAPTER_PARSE_ERROR' | 'AGENT_SCHEMA_ERROR' | 'RATE_LIMIT';

export interface ParseResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
  failureKind?: FailureKind;
  providerMessage?: string;
  providerStatus?: number;
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

function tryParse(text: string): unknown | null {
  try { return JSON.parse(text); } catch { return null; }
}

const RATE_LIMIT_RE = [
  /rate.?limit/i, /quota (?:exceeded|exhausted)/i, /usage limit/i,
  /too many requests/i, /\b429\b/, /you(?:'| ha)ve (?:reached|hit) your/i, /resets? at/i,
];
export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_RE.some((re) => re.test(text));
}

/** Last balanced {...} run in a string. */
function lastJsonObject(text: string): unknown | null {
  let depth = 0, start = -1, inStr = false, esc = false;
  const candidates: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1)); }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = tryParse(candidates[i]);
    if (v && typeof v === 'object') return v;
  }
  return null;
}

export interface EnvelopeInspection {
  kind: 'error' | 'payload';
  body: string;
  providerMessage?: string;
  providerStatus?: number;
  rateLimited?: boolean;
}

/** Claude stream-json / codex JSONL → assistant text; error envelopes surfaced. */
export function inspectEnvelope(raw: string): EnvelopeInspection {
  const top = tryParse(raw.trim());
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    const o = top as Record<string, any>;
    if (o.type === 'result' || 'is_error' in o || 'subtype' in o) {
      const status = typeof o.api_error_status === 'number' ? o.api_error_status : undefined;
      const failed = o.is_error === true || status !== undefined ||
        o.terminal_reason === 'api_error' || o.terminal_reason === 'error';
      const message = typeof o.result === 'string' ? o.result
        : typeof o.error === 'string' ? o.error
          : `provider failure (${String(o.terminal_reason)})`;
      if (failed) {
        return {
          kind: 'error', body: message, providerMessage: message, providerStatus: status,
          rateLimited: status === 429 || looksRateLimited(message),
        };
      }
      if (typeof o.result === 'string') return { kind: 'payload', body: o.result };
    }
    if (typeof o.text === 'string') return { kind: 'payload', body: o.text };
  }

  // JSONL streams: collect assistant text, and surface stream-level errors.
  const texts: string[] = [];
  let errorLine: EnvelopeInspection | null = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: any; try { ev = JSON.parse(t); } catch { continue; }
    // codex
    if (ev?.type === 'item.completed' && typeof ev?.item?.text === 'string' &&
        (ev.item.type === 'agent_message' || ev.item.type === undefined)) texts.push(ev.item.text);
    if (ev?.type === 'turn.failed' || ev?.type === 'error') {
      const msg = String(ev?.error?.message ?? ev?.message ?? 'provider turn failed');
      errorLine = { kind: 'error', body: msg, providerMessage: msg, rateLimited: looksRateLimited(msg) };
    }
    // claude stream-json
    const content = ev?.message?.content;
    if (Array.isArray(content)) for (const part of content) {
      if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
    if (ev?.type === 'result') {
      const sub = inspectEnvelope(t);
      if (sub.kind === 'error') errorLine = sub;
      else if (sub.body) texts.push(sub.body);
    }
    if (ev?.type === 'rate_limit_event' && ev?.rate_limit_info?.status &&
        ev.rate_limit_info.status !== 'allowed' && ev.rate_limit_info.status !== 'allowed_warning') {
      errorLine = { kind: 'error', body: 'provider rate limit', providerMessage: 'rate limit', rateLimited: true };
    }
  }
  if (errorLine && !texts.length) return errorLine;
  if (texts.length) return { kind: 'payload', body: texts[texts.length - 1] };
  return { kind: 'payload', body: raw };
}

export function parseStructured<T = Record<string, unknown>>(raw: string, requiredKeys: string[]): ParseResult<T> {
  const env = inspectEnvelope(raw);
  if (env.kind === 'error') {
    return {
      ok: false, value: null,
      failureKind: env.rateLimited ? 'RATE_LIMIT' : 'AGENT_EXECUTION_ERROR',
      providerMessage: env.providerMessage, providerStatus: env.providerStatus,
      error: `agent did not run: ${env.providerMessage ?? 'provider failure'}` +
        (env.providerStatus ? ` (HTTP ${env.providerStatus})` : ''),
    };
  }
  const body = env.body;
  if (!body.trim()) return { ok: false, value: null, failureKind: 'AGENT_EXECUTION_ERROR', error: 'agent produced no output at all' };

  const attempts: unknown[] = [];
  const direct = tryParse(body.trim());
  if (direct) attempts.push(direct);
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(body)) !== null) { const v = tryParse(m[1].trim()); if (v) attempts.push(v); }
  const loose = lastJsonObject(body);
  if (loose) attempts.push(loose);

  for (let i = attempts.length - 1; i >= 0; i--) {
    const c = attempts[i];
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const obj = c as Record<string, unknown>;
      if (requiredKeys.every((k) => k in obj)) return { ok: true, value: obj as T };
    }
  }
  const objects = attempts.filter((a) => a && typeof a === 'object' && !Array.isArray(a)) as Record<string, unknown>[];
  if (objects.length) {
    const missing = requiredKeys.filter((k) => !(k in objects[objects.length - 1]));
    return { ok: false, value: null, failureKind: 'AGENT_SCHEMA_ERROR', error: `structured output missing required keys: ${missing.join(', ')}` };
  }
  return { ok: false, value: null, failureKind: 'ADAPTER_PARSE_ERROR', error: 'no JSON object found in agent output' };
}
