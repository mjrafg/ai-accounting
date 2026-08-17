/**
 * Extracts the structured block an agent was asked to return.
 *
 * Agents wrap JSON in prose, fences, or a Claude Code `--output-format json`
 * envelope. Parsing is strict about the result -- a shape that does not match
 * is reported as a parse failure rather than coerced, because a silently
 * half-parsed design or finding list is worse than an obvious error.
 */

/**
 * Three genuinely different failures, which used to be reported as one.
 *
 *   AGENT_EXECUTION_ERROR - the CLI or the model never produced an answer:
 *                           expired credentials, an API error, a non-zero exit,
 *                           a timeout. Nothing to parse; the fix is operational.
 *   ADAPTER_PARSE_ERROR   - the agent answered but we could not extract JSON.
 *                           The fix is in this file, or in the prompt.
 *   AGENT_SCHEMA_ERROR    - JSON extracted, but required fields are missing.
 *                           The fix is the agent's, not ours.
 *
 * Collapsing these cost real diagnosis time: an expired OAuth token surfaced as
 * "no JSON object found in agent output", which points at the parser and says
 * nothing about the actual cause.
 */
export type AgentFailureKind =
  | 'AGENT_EXECUTION_ERROR'
  | 'ADAPTER_PARSE_ERROR'
  | 'AGENT_SCHEMA_ERROR';

export interface ParseResult<T> {
  ok: boolean;
  value: T | null;
  error?: string;
  failureKind?: AgentFailureKind;
  /** Set when the provider itself reported the failure, verbatim. */
  providerMessage?: string;
  /** HTTP status the provider reported, when it did. */
  providerStatus?: number;
}

export interface EnvelopeInspection {
  /** 'error' - transport/provider failure; 'payload' - agent text to parse. */
  kind: 'error' | 'payload';
  body: string;
  providerMessage?: string;
  providerStatus?: number;
  terminalReason?: string;
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
 * Codex `exec --json` emits a JSONL event stream rather than one document, and
 * the agent's own answer arrives as an escaped string inside
 * `item.completed -> item.text`. Without unwrapping it, a perfectly valid
 * review looks like malformed output.
 */
function unwrapEventStream(raw: string): string | null {
  const messages: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev?.type === 'item.completed' && ev?.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      messages.push(ev.item.text);
    } else if (ev?.type === 'item.completed' && typeof ev?.item?.text === 'string') {
      messages.push(ev.item.text);
    }
  }
  if (!messages.length) return null;
  // The last message is the agent's final answer; earlier ones are narration.
  return messages[messages.length - 1];
}

/**
 * Claude Code `--print --output-format stream-json` emits JSONL where assistant
 * turns arrive as `{type:'assistant', message:{content:[{type:'text',text}]}}`
 * and the run ends with a `type:'result'` line. Supported so switching output
 * modes does not silently become a parse failure.
 */
function unwrapClaudeStream(raw: string): string | null {
  const texts: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  return texts.length ? texts.join('\n') : null;
}

/**
 * Reads the CLI's own envelope before anything tries to find JSON in it.
 *
 * This is the layer that was missing. The Claude CLI reports transport failures
 * *inside* a perfectly well-formed JSON envelope — `is_error: true` with the
 * human-readable cause in `result` — and, confusingly, still sets
 * `subtype: "success"` and can exit 0. Blindly unwrapping `result` therefore
 * handed an English error sentence to the JSON extractor.
 */
export function inspectEnvelope(raw: string): EnvelopeInspection {
  const top = tryParse(raw.trim());
  if (top && typeof top === 'object' && !Array.isArray(top)) {
    const o = top as Record<string, any>;
    const isResultEnvelope = o.type === 'result' || 'is_error' in o || 'subtype' in o;
    if (isResultEnvelope) {
      const status = typeof o.api_error_status === 'number' ? o.api_error_status : undefined;
      const failed =
        o.is_error === true ||
        status !== undefined ||
        o.terminal_reason === 'api_error' ||
        o.terminal_reason === 'error';
      const message =
        typeof o.result === 'string'
          ? o.result
          : typeof o.error === 'string'
            ? o.error
            : `provider reported failure (terminal_reason=${String(o.terminal_reason)})`;
      if (failed) {
        return {
          kind: 'error',
          body: message,
          providerMessage: message,
          providerStatus: status,
          terminalReason: typeof o.terminal_reason === 'string' ? o.terminal_reason : undefined,
        };
      }
      if (typeof o.result === 'string') return { kind: 'payload', body: o.result };
    }
    // Non-envelope object with a text field (some providers nest it there).
    if (typeof o.text === 'string') return { kind: 'payload', body: o.text };
  }

  // JSONL streams. Codex's own error events are surfaced rather than ignored.
  const codexStream = unwrapEventStream(raw);
  if (codexStream) return { kind: 'payload', body: codexStream };
  const claudeStream = unwrapClaudeStream(raw);
  if (claudeStream) return { kind: 'payload', body: claudeStream };

  return { kind: 'payload', body: raw };
}

/**
 * Unwraps a provider envelope to the agent's own payload. Retained for callers
 * that only want the text; `inspectEnvelope` is what distinguishes an error
 * envelope from a payload one.
 */
export function unwrapEnvelope(raw: string): string {
  return inspectEnvelope(raw).body;
}

/** Provider usage, only when the provider actually reported it. */
export function extractUsage(raw: string): { inputTokens?: number; outputTokens?: number; costUsd?: number } | null {
  // Codex reports usage on its turn.completed event.
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t);
      if (ev?.type === 'turn.completed' && ev?.usage) {
        const u: { inputTokens?: number; outputTokens?: number } = {};
        if (typeof ev.usage.input_tokens === 'number') u.inputTokens = ev.usage.input_tokens;
        if (typeof ev.usage.output_tokens === 'number') u.outputTokens = ev.usage.output_tokens;
        if (Object.keys(u).length) return u;
      }
    } catch { /* not an event line */ }
  }
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
  const env = inspectEnvelope(raw);

  // The provider told us it failed. Report that, and do not go looking for JSON
  // in an error message — which is exactly how an expired token became
  // "no JSON object found in agent output".
  if (env.kind === 'error') {
    return {
      ok: false,
      value: null,
      failureKind: 'AGENT_EXECUTION_ERROR',
      providerMessage: env.providerMessage,
      providerStatus: env.providerStatus,
      error:
        `agent did not run: ${env.providerMessage ?? 'provider reported failure'}` +
        (env.providerStatus ? ` (HTTP ${env.providerStatus})` : ''),
    };
  }

  const body = env.body;

  if (!body.trim()) {
    return {
      ok: false,
      value: null,
      failureKind: 'AGENT_EXECUTION_ERROR',
      error: 'agent produced no output at all',
    };
  }

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

  // An object was extracted but does not satisfy the schema. That is the agent's
  // failure, not the parser's, and the schema is NOT relaxed to accommodate it.
  const objects = attempts.filter(
    (a) => a && typeof a === 'object' && !Array.isArray(a),
  ) as Record<string, unknown>[];
  if (objects.length) {
    const best = objects[objects.length - 1];
    const missing = requiredKeys.filter((k) => !(k in best));
    return {
      ok: false,
      value: null,
      failureKind: 'AGENT_SCHEMA_ERROR',
      error: `structured output missing required keys: ${missing.join(', ')}`,
    };
  }

  return {
    ok: false,
    value: null,
    failureKind: 'ADAPTER_PARSE_ERROR',
    error: 'no JSON object found in agent output',
  };
}
