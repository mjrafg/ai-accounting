#!/usr/bin/env ts-node
/**
 * Deterministic tests for provider envelope handling and structured extraction.
 *
 * No live model is called. Every input is a fixture, and the first one is the
 * exact (sanitized) output that escalated TASK-0007 — an expired-OAuth envelope
 * that the parser reported as "no JSON object found in agent output", pointing
 * a whole investigation at the wrong layer.
 *
 *   pnpm ai parser-selftest
 */
import { parseStructured, inspectEnvelope } from './parsers/structured-output';
import { looksRateLimited } from './agents/transport';

const DESIGN_KEYS = ['scopeAllowlist', 'outOfScope', 'invariants', 'requiredTests'];

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(` FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * TASK-0007, verbatim except session_id/uuid which are replaced with fixed
 * placeholders. Valid JSON, is_error true, subtype misleadingly "success",
 * and the cause in `result` as an English sentence.
 */
const TASK_0007_EXPIRED_OAUTH = JSON.stringify({
  is_error: true,
  duration_api_ms: 0,
  num_turns: 1,
  stop_reason: 'stop_sequence',
  session_id: '00000000-0000-0000-0000-000000000000',
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  modelUsage: {},
  permission_denials: [],
  terminal_reason: 'api_error',
  fast_mode_state: 'off',
  subtype: 'success',
  api_error_status: 401,
  result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
  type: 'result',
  duration_ms: 32442,
  uuid: '00000000-0000-0000-0000-000000000001',
});

const VALID_DESIGN = {
  scopeAllowlist: ['packages/server/src/modules/Attachments/Attachments.controller.ts'],
  outOfScope: ['packages/server/tsconfig.json'],
  invariants: ['presigned-url route unchanged'],
  requiredTests: ['unit: getAttachment content-type mapping'],
};

/** A healthy Claude CLI envelope carrying a design as a plain JSON string. */
const ENVELOPE_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 20 },
  result: JSON.stringify(VALID_DESIGN),
});

/** Same, but the agent fenced its JSON inside markdown. */
const ENVELOPE_FENCED = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Here is the design.\n\n```json\n' + JSON.stringify(VALID_DESIGN, null, 2) + '\n```\n\nLet me know.',
});

/** stream-json JSONL, assistant text nested under message.content[]. */
const STREAM_JSON = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: JSON.stringify(VALID_DESIGN) }] },
  }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' }),
].join('\n');

/** Codex JSONL, agent text under item.completed -> item.text. */
const CODEX_STREAM = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: JSON.stringify({ verdict: 'CLEAN', findings: [] }) },
  }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 6 } }),
].join('\n');

const QUOTA_ENVELOPE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 429,
  terminal_reason: 'api_error',
  result: 'API Error: 429 rate limit exceeded. Your usage limit resets at 3pm.',
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

export function runParserSelfTests(): number {
  console.log('parser / envelope self-tests (no live model)\n');

  // --- 1. THE TASK-0007 REGRESSION -----------------------------------------
  console.log('- TASK-0007 regression: expired OAuth inside a valid envelope');
  {
    const env = inspectEnvelope(TASK_0007_EXPIRED_OAUTH);
    check('envelope classified as an error', env.kind === 'error', env.kind);
    check('provider HTTP status surfaced', env.providerStatus === 401, String(env.providerStatus));
    check(
      'provider message preserved verbatim',
      (env.providerMessage ?? '').includes('OAuth access token has expired'),
    );

    const r = parseStructured(TASK_0007_EXPIRED_OAUTH, DESIGN_KEYS);
    check('parse fails', !r.ok);
    check(
      'classified AGENT_EXECUTION_ERROR (not a parser bug)',
      r.failureKind === 'AGENT_EXECUTION_ERROR',
      String(r.failureKind),
    );
    // The whole point: the old message was "no JSON object found in agent output".
    check(
      'error no longer blames the parser',
      !(r.error ?? '').includes('no JSON object found'),
      r.error ?? '',
    );
    check(
      'error names the real cause',
      (r.error ?? '').includes('OAuth access token has expired') && (r.error ?? '').includes('401'),
    );
    check('not misread as a rate limit', !looksRateLimited(env.providerMessage ?? ''));
  }

  // --- 2. direct JSON -------------------------------------------------------
  console.log('- direct JSON (no envelope)');
  {
    const r = parseStructured(JSON.stringify(VALID_DESIGN), DESIGN_KEYS);
    check('parses', r.ok, r.error ?? '');
    check('scopeAllowlist survives', Array.isArray((r.value as any)?.scopeAllowlist));
  }

  // --- 3. real CLI envelope -------------------------------------------------
  console.log('- Claude CLI --output-format json envelope');
  {
    const r = parseStructured(ENVELOPE_OK, DESIGN_KEYS);
    check('unwraps result and parses', r.ok, r.error ?? '');
    check('required keys present', DESIGN_KEYS.every((k) => k in ((r.value as any) ?? {})));
  }

  // --- 4. fenced JSON inside the envelope ----------------------------------
  console.log('- fenced JSON inside the envelope, with prose around it');
  {
    const r = parseStructured(ENVELOPE_FENCED, DESIGN_KEYS);
    check('parses through fence + prose', r.ok, r.error ?? '');
  }

  // --- 5. stream-json ------------------------------------------------------
  console.log('- stream-json JSONL (message.content[].text)');
  {
    const r = parseStructured(STREAM_JSON, DESIGN_KEYS);
    check('parses nested assistant text', r.ok, r.error ?? '');
  }

  // --- 6. codex JSONL ------------------------------------------------------
  console.log('- codex exec --json JSONL (item.completed -> item.text)');
  {
    const r = parseStructured(CODEX_STREAM, ['verdict', 'findings']);
    check('parses codex event stream', r.ok, r.error ?? '');
  }

  // --- 7. malformed JSON ---------------------------------------------------
  console.log('- malformed JSON');
  {
    const r = parseStructured('{"scopeAllowlist": [ , broken', DESIGN_KEYS);
    check('fails', !r.ok);
    check('classified ADAPTER_PARSE_ERROR', r.failureKind === 'ADAPTER_PARSE_ERROR', String(r.failureKind));
  }

  // --- 8. valid JSON, missing required fields ------------------------------
  console.log('- valid JSON missing required fields');
  {
    const r = parseStructured(JSON.stringify({ scopeAllowlist: [], invariants: [] }), DESIGN_KEYS);
    check('fails', !r.ok);
    check('classified AGENT_SCHEMA_ERROR', r.failureKind === 'AGENT_SCHEMA_ERROR', String(r.failureKind));
    check('names the missing keys', /outOfScope/.test(r.error ?? '') && /requiredTests/.test(r.error ?? ''), r.error ?? '');
    check('does NOT relax the schema', r.value === null);
  }

  // --- 9. prose with braces that is not a result ---------------------------
  console.log('- prose containing braces that is not a structured result');
  {
    const prose =
      'I looked at the controller. The handler uses mime.extension(contentType) ' +
      'inside a block { like this } and the config { module: commonjs } matters. ' +
      'I cannot produce a design without more detail.';
    const r = parseStructured(prose, DESIGN_KEYS);
    check('fails rather than accepting prose', !r.ok);
    check('value is null', r.value === null);
    check(
      'classified as parse or schema failure, never ok',
      r.failureKind === 'ADAPTER_PARSE_ERROR' || r.failureKind === 'AGENT_SCHEMA_ERROR',
      String(r.failureKind),
    );
  }

  // --- 10. empty output ----------------------------------------------------
  console.log('- empty output');
  {
    const r = parseStructured('', DESIGN_KEYS);
    check('fails', !r.ok);
    check('classified AGENT_EXECUTION_ERROR', r.failureKind === 'AGENT_EXECUTION_ERROR', String(r.failureKind));
  }

  // --- 11. quota exhaustion is still a pause, not a parse error ------------
  console.log('- quota exhaustion inside an exit-0 envelope');
  {
    const env = inspectEnvelope(QUOTA_ENVELOPE);
    check('classified as an error envelope', env.kind === 'error');
    check(
      'recognised as rate limited from the provider message',
      looksRateLimited(env.providerMessage ?? ''),
      env.providerMessage ?? '',
    );
    const r = parseStructured(QUOTA_ENVELOPE, DESIGN_KEYS);
    check('surfaces provider status 429', r.providerStatus === 429, String(r.providerStatus));
  }

  // --- 12. a healthy envelope must never be mistaken for an error ---------
  console.log('- healthy envelope is not misclassified');
  {
    check('is_error:false stays a payload', inspectEnvelope(ENVELOPE_OK).kind === 'payload');
  }

  console.log(`\nparser self-tests: ${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}
