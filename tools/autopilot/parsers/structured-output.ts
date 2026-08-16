/**
 * Extracts the structured block an agent was asked to return.
 *
 * Agents wrap JSON in prose, fences, or a Claude Code `--output-format json`
 * envelope. Parsing is strict about the result -- a shape that does not match
 * is reported as a parse failure rather than coerced, because a silently
 * half-parsed design or finding list is worse than an obvious error.
 */

export interface ParseResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Finds the last balanced {...} run in a string. */
function lastJsonObject(text: string): unknown | null {
  let depth = 0;
  let start = -1;
  const candidates: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1));
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const v = tryParse(candidates[i]);
    if (v && typeof v === 'object') return v;
  }
  return null;
}

/**
 * Unwraps the Claude Code `--output-format json` envelope when present, so
 * callers always see the agent's own payload.
 */
export function unwrapEnvelope(raw: string): string {
  const top = tryParse(raw);
  if (top && typeof top === 'object') {
    const o = top as Record<string, unknown>;
    if (typeof o.result === 'string') return o.result;
    if (Array.isArray(o) === false && typeof o.text === 'string') return o.text as string;
  }
  return raw;
}

/** Provider usage, only when the provider actually reported it. */
export function extractUsage(raw: string): { inputTokens?: number; outputTokens?: number; costUsd?: number } | null {
  const top = tryParse(raw);
  if (!top || typeof top !== 'object') return null;
  const o = top as Record<string, any>;
  const usage = o.usage ?? o.token_usage;
  const cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : undefined;
  if (!usage && cost === undefined) return null;
  const out: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
  if (usage && typeof usage.input_tokens === 'number') out.inputTokens = usage.input_tokens;
  if (usage && typeof usage.output_tokens === 'number') out.outputTokens = usage.output_tokens;
  if (cost !== undefined) out.costUsd = cost;
  return Object.keys(out).length ? out : null;
}

export function parseStructured<T = Record<string, unknown>>(
  raw: string,
  requiredKeys: string[],
): ParseResult<T> {
  const body = unwrapEnvelope(raw);

  const attempts: unknown[] = [];
  const direct = tryParse(body.trim());
  if (direct) attempts.push(direct);

  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(body)) !== null) {
    const v = tryParse(m[1].trim());
    if (v) attempts.push(v);
  }

  const loose = lastJsonObject(body);
  if (loose) attempts.push(loose);

  for (let i = attempts.length - 1; i >= 0; i--) {
    const candidate = attempts[i];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const obj = candidate as Record<string, unknown>;
      const missing = requiredKeys.filter((k) => !(k in obj));
      if (missing.length === 0) return { ok: true, value: obj as T };
    }
  }

  const sawJson = attempts.length > 0;
  return {
    ok: false,
    value: null,
    error: sawJson
      ? `structured output missing required keys: ${requiredKeys.join(', ')}`
      : 'no JSON object found in agent output',
  };
}
