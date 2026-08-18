/**
 * Streaming agent adapters.
 *
 * Live output is a first-class feature: every chunk the installed CLI makes
 * available is pushed through redaction into the stream log the moment it
 * arrives — never buffered until process exit. Contracts verified against the
 * real binaries on this host (claude 2.1.233, codex-cli 0.147.0):
 *
 *   claude -p --output-format stream-json --include-partial-messages --verbose
 *     JSONL: system/init, stream_event{content_block_delta:{text_delta|thinking_delta}},
 *            assistant (full messages incl. tool_use), rate_limit_event, result envelope
 *   codex exec --json
 *     JSONL: thread.started, turn.started, item.started/updated/completed
 *            (agent_message | reasoning | command_execution), turn.completed|failed
 *
 * Billing: SUBSCRIPTION_CLI_ONLY. API keys are stripped from the child env so
 * a paid fallback is structurally impossible from here.
 */
import { spawn } from 'child_process';
import { StreamLog, writeRawArtifact } from './store';
import { parseStructured, looksRateLimited, FailureKind } from './parsers';
import { AgentRunResult } from './types';
import { RunHandle, registerRun, unregisterRun, signalGroup } from './procs';

export const BILLING_MODE = 'SUBSCRIPTION_CLI_ONLY';
const BANNED_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of BANNED_ENV) delete env[k];
  return env;
}
export function bannedKeysPresent(): string[] {
  return BANNED_ENV.filter((k) => (process.env[k] ?? '').length > 0);
}

const CLAUDE_BIN = process.env.AI_CLAUDE_BIN ?? '/home/aiaccounting/.local/bin/claude';
const CODEX_BIN = process.env.AI_CODEX_BIN ?? '/home/aiaccounting/.nvm/versions/node/v18.16.1/bin/codex';

/**
 * Model policy: Claude Fable 5 is the preferred model for every Claude role
 * (design, adjudication, implementation, report generation). Verified on this
 * host: CLI 2.1.233 accepts --model claude-fable-5 and the result envelope's
 * modelUsage confirms the effective model under the SUBSCRIPTION login — no
 * API key involved. Codex stays the independent reviewer, never replaced.
 */
export const CLAUDE_MODEL = process.env.AI_V2_CLAUDE_MODEL ?? 'claude-fable-5';

let cliVersionCache: string | null = null;
export function claudeCliVersion(): string {
  if (cliVersionCache) return cliVersionCache;
  try {
    const r = require('child_process').execFileSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 15000 });
    cliVersionCache = String(r).trim();
  } catch { cliVersionCache = 'unknown'; }
  return cliVersionCache!;
}

let codexVersionCache: string | null = null;
export function codexCliVersion(): string {
  if (codexVersionCache) return codexVersionCache;
  try {
    // The codex launcher is a node script: it needs node's dir on PATH.
    const r = require('child_process').execFileSync(CODEX_BIN, ['--version'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PATH: `${require('path').dirname(CODEX_BIN)}:/usr/bin:/bin` },
    });
    codexVersionCache = String(r).trim();
  } catch { codexVersionCache = 'unknown'; }
  return codexVersionCache!;
}

export type AgentName = 'claude' | 'codex' | 'claude-code';

// Task-owned process bookkeeping lives in ./procs so that agents and checks
// share one registry (and one definition of "this task's processes").

export interface AgentSpec {
  agent: AgentName;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** Required keys of the structured result; empty = free text is fine. */
  requiredKeys: string[];
  readOnly?: boolean;
  taskId: string;
  phase: string;
  /** Model override for either provider; defaults: CLAUDE_MODEL / codex CLI default. */
  model?: string;
  /** Role id from the model registry (e.g. claude.design) — observability only here. */
  role?: string;
  /** Identifies this pipeline execution; ties spawned processes to the run. */
  runId?: string;
  /** Consulted before spawning and before any retry: true = stop immediately. */
  isCancelled?: () => boolean;
  /** Reasoning effort; provider-validated upstream. null/undefined = provider default. */
  reasoning?: string | null;
}

function argvFor(spec: AgentSpec): string[] {
  if (spec.agent === 'codex') {
    return [CODEX_BIN, 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check',
      ...(spec.model ? ['-m', spec.model] : []),
      ...(spec.reasoning ? ['-c', `model_reasoning_effort=${spec.reasoning}`] : []),
      spec.prompt];
  }
  const tools = spec.agent === 'claude-code' && !spec.readOnly
    ? ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
    : ['Read', 'Grep', 'Glob', 'Bash'];
  return [
    CLAUDE_BIN, '-p', spec.prompt,
    '--model', spec.model ?? CLAUDE_MODEL,
    ...(spec.reasoning ? ['--effort', spec.reasoning] : []),
    '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
    '--permission-mode', spec.agent === 'claude-code' ? 'acceptEdits' : 'manual',
    '--allowed-tools', tools.join(' '),
  ];
}

interface StreamState {
  finalEnvelope: string | null;
  effectiveModel: string | null;
  codexThreadId: string | null;
  assistantTexts: string[];
  rateLimited: boolean;
  textBuf: string;
  thinkingTokens: number;
  firstChunkAt: number | null;
}

/**
 * Effective codex model, read from the session rollout's turn_context — the
 * only place codex-cli 0.147.0 records which model actually served the turn
 * (verified on this host: payload.model = "gpt-5.6-sol").
 */
export function codexEffectiveModel(threadId: string | null): string | null {
  if (!threadId || !/^[a-f0-9-]{16,64}$/i.test(threadId)) return null;
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const root = path.join(process.env.AI_CODEX_HOME ?? '/home/aiaccounting/.codex', 'sessions');
    const days: string[] = [];
    for (const y of fs.readdirSync(root).sort().slice(-2)) {
      for (const m of fs.readdirSync(path.join(root, y)).sort().slice(-2)) {
        for (const d of fs.readdirSync(path.join(root, y, m)).sort().slice(-3)) {
          days.push(path.join(root, y, m, d));
        }
      }
    }
    for (const day of days.reverse()) {
      const f = fs.readdirSync(day).find((x: string) => x.includes(threadId));
      if (!f) continue;
      for (const line of fs.readFileSync(path.join(day, f), 'utf8').split('\n')) {
        if (!line.includes('"turn_context"')) continue;
        try {
          const o = JSON.parse(line);
          if (o?.type === 'turn_context' && o?.payload?.model) return String(o.payload.model);
        } catch { /* skip */ }
      }
    }
  } catch { /* best effort */ }
  return null;
}

/** Turns one provider JSONL line into zero-or-more live chunks. */
function ingestLine(
  spec: AgentSpec, line: string, st: StreamState,
  emit: (kind: string, text: string) => void,
): void {
  let ev: any;
  try { ev = JSON.parse(line); } catch {
    if (line.trim()) emit('text', line);
    return;
  }
  if (st.firstChunkAt === null) st.firstChunkAt = Date.now();

  if (spec.agent === 'codex') {
    switch (ev.type) {
      case 'thread.started':
        st.codexThreadId = String(ev.thread_id ?? '') || null;
        emit('lifecycle', 'session started');
        break;
      case 'turn.started': emit('lifecycle', 'turn started'); break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const it = ev.item ?? {};
        if (it.type === 'agent_message' && typeof it.text === 'string') {
          if (ev.type === 'item.completed') { st.assistantTexts.push(it.text); emit('text', it.text); }
        } else if (it.type === 'reasoning' && typeof it.text === 'string') {
          if (ev.type === 'item.completed') emit('thinking', it.text);
        } else if (it.type === 'command_execution') {
          if (ev.type === 'item.started') emit('tool', `$ ${it.command ?? ''}`);
          else if (ev.type === 'item.completed') emit('tool', `exit ${it.exit_code ?? '?'}${it.aggregated_output ? `\n${String(it.aggregated_output).slice(0, 2000)}` : ''}`);
        } else if (ev.type === 'item.completed' && typeof it.text === 'string') {
          st.assistantTexts.push(it.text); emit('text', it.text);
        }
        break;
      }
      case 'turn.completed': emit('lifecycle', `turn completed (${ev.usage?.output_tokens ?? '?'} out tokens)`); break;
      case 'turn.failed': case 'error': {
        const msg = String(ev?.error?.message ?? ev?.message ?? 'turn failed');
        if (looksRateLimited(msg)) st.rateLimited = true;
        emit('error', msg);
        break;
      }
      default: break;
    }
    return;
  }

  // claude / claude-code stream-json
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') emit('lifecycle', `session started (${ev.model ?? 'claude'})`);
      break;
    case 'rate_limit_event': {
      const s = ev?.rate_limit_info?.status;
      if (s && s !== 'allowed' && s !== 'allowed_warning') { st.rateLimited = true; emit('error', `rate limit: ${s}`); }
      break;
    }
    case 'stream_event': {
      const e = ev.event ?? {};
      if (e.type === 'message_start' && ev?.event?.message?.model) {
        st.effectiveModel = String(ev.event.message.model);
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta ?? {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          st.textBuf += d.text;
          // Flush on line breaks so the browser sees sentences, not single chars.
          const idx = st.textBuf.lastIndexOf('\n');
          if (idx >= 0) { emit('text', st.textBuf.slice(0, idx + 1)); st.textBuf = st.textBuf.slice(idx + 1); }
          else if (st.textBuf.length > 400) { emit('text', st.textBuf); st.textBuf = ''; }
        } else if (d.type === 'thinking_delta') {
          st.thinkingTokens += Number(d.estimated_tokens ?? 0) || 0;
        }
      } else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        emit('tool', `→ ${e.content_block.name ?? 'tool'}`);
      } else if (e.type === 'message_stop' && st.thinkingTokens > 0) {
        emit('thinking', `(thought ~${st.thinkingTokens} tokens)`); st.thinkingTokens = 0;
      }
      break;
    }
    case 'assistant': {
      const content = ev?.message?.content;
      if (Array.isArray(content)) for (const part of content) {
        if (part?.type === 'tool_use') {
          const input = JSON.stringify(part.input ?? {}).slice(0, 300);
          emit('tool', `→ ${part.name}(${input})`);
        } else if (part?.type === 'text' && typeof part.text === 'string') {
          st.assistantTexts.push(part.text);
        }
      }
      break;
    }
    case 'user': {
      const content = ev?.message?.content;
      if (Array.isArray(content)) for (const part of content) {
        if (part?.type === 'tool_result') {
          const txt = typeof part.content === 'string' ? part.content
            : Array.isArray(part.content) ? part.content.map((c: any) => c?.text ?? '').join('') : '';
          if (txt) emit('tool', `← ${String(txt).slice(0, 1200)}`);
        }
      }
      break;
    }
    case 'result':
      st.finalEnvelope = line;
      break;
    default: break;
  }
}

/**
 * Runs one agent invocation with live streaming. Chunks reach the StreamLog
 * (already redacted there) as they arrive; the return value carries the parsed
 * structured result and its failure classification.
 */
export function runAgentStreaming(spec: AgentSpec, stream: StreamLog): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const argv = argvFor(spec);
    const started = Date.now();
    const st: StreamState = { finalEnvelope: null, effectiveModel: null, codexThreadId: null, assistantTexts: [], rateLimited: false, textBuf: '', thinkingTokens: 0, firstChunkAt: null };
    const emit = (kind: string, text: string) => stream.append(spec.taskId, spec.agent, kind, text, spec.phase);

    stream.append(spec.taskId, spec.agent, 'lifecycle', `● started (${spec.phase})`, spec.phase);
    // detached:true puts the child in its OWN process group (setsid), so the
    // agent and every descendant it spawns — shells, jest, watchers, even
    // processes that detach themselves — can be signalled as one unit with
    // kill(-pgid). Without this the child joins the SERVER's process group and
    // nothing task-scoped is killable.
    const child = spawn(argv[0], argv.slice(1), {
      cwd: spec.cwd, env: subscriptionEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const handle: RunHandle = { taskId: spec.taskId, runId: spec.runId ?? '', pid: child.pid ?? 0,
      pgid: child.pid ?? 0, kind: 'agent', label: `${spec.agent} ${spec.phase}`, cwd: spec.cwd, startedAt: Date.now() };
    registerRun(handle);

    let killed = false;
    const timer = setTimeout(() => { killed = true; signalGroup(handle.pgid, 'SIGKILL'); }, spec.timeoutMs);

    let buf = '';
    const rawLines: string[] = [];
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (line.trim()) { rawLines.push(line); ingestLine(spec, line, st, emit); }
      }
    });
    let errBuf = '';
    child.stderr.on('data', (d: Buffer) => { errBuf += d.toString('utf8'); });

    child.on('close', (code) => {
      clearTimeout(timer);
      unregisterRun(handle.pid);
      if (buf.trim()) { rawLines.push(buf); ingestLine(spec, buf, st, emit); }
      if (st.textBuf) emit('text', st.textBuf);

      // Raw envelope kept 0600 for debugging; never served to the browser.
      writeRawArtifact(spec.taskId, `${spec.agent}-${spec.phase.replace(/\W+/g, '_')}-${started}.raw.jsonl`,
        rawLines.join('\n') + (errBuf ? `\n--- stderr ---\n${errBuf}` : ''));

      const finalText = st.assistantTexts.length ? st.assistantTexts.join('\n') : '';
      const parseSource = st.finalEnvelope ?? (finalText || errBuf);
      const parsed = spec.requiredKeys.length
        ? parseStructured(parseSource, spec.requiredKeys)
        : { ok: true, value: null, error: undefined, failureKind: undefined as FailureKind | undefined };

      // A parse against the envelope alone can miss text carried in assistant
      // events; fall back to the collected assistant text before failing.
      let effective = parsed;
      if (!parsed.ok && spec.requiredKeys.length && finalText && parseSource !== finalText) {
        const second = parseStructured(finalText, spec.requiredKeys);
        if (second.ok) effective = second;
      }

      const rateLimited = st.rateLimited || effective.failureKind === 'RATE_LIMIT' ||
        (code !== 0 && looksRateLimited(errBuf));

      const ok = !killed && code === 0 && effective.ok && !rateLimited;
      const kind: FailureKind | undefined = ok ? undefined
        : rateLimited ? 'RATE_LIMIT'
          : killed || code === null ? 'AGENT_EXECUTION_ERROR'
            : effective.failureKind ?? (code !== 0 ? 'AGENT_EXECUTION_ERROR' : 'ADAPTER_PARSE_ERROR');

      emit('lifecycle', ok ? '○ finished' : `○ ${kind}${effective.error ? `: ${effective.error.slice(0, 300)}` : ''}`);
      resolve({
        ok,
        structured: effective.value as any,
        text: finalText,
        exitCode: code,
        durationMs: Date.now() - started,
        rateLimited,
        failureKind: kind,
        providerStatus: (effective as any).providerStatus,
        error: ok ? undefined
          : rateLimited ? 'subscription quota or rate limit reached'
            : killed ? `agent timed out after ${Math.round(spec.timeoutMs / 1000)}s`
              : effective.error ?? `agent exited ${code}`,
        attempts: 1,
        usage: null,
        firstChunkMs: st.firstChunkAt ? st.firstChunkAt - started : undefined,
        requestedModel: spec.agent === 'codex' ? (spec.model ?? 'codex-default') : (spec.model ?? CLAUDE_MODEL),
        effectiveModel: spec.agent === 'codex'
          ? (codexEffectiveModel(st.codexThreadId) ?? undefined)
          : (st.effectiveModel ?? undefined),
        cliVersion: spec.agent === 'codex' ? codexCliVersion() : claudeCliVersion(),
        authMode: spec.agent === 'codex' ? 'chatgpt-subscription' : 'subscription-cli',
        role: spec.role,
        reasoningEffort: spec.reasoning ?? undefined,
        provider: spec.agent,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      emit('error', `spawn failed: ${err.message}`);
      resolve({
        ok: false, structured: null, text: '', exitCode: null, durationMs: Date.now() - started,
        rateLimited: false, failureKind: 'AGENT_EXECUTION_ERROR', error: `spawn failed: ${err.message}`, attempts: 1, usage: null,
      });
    });
  });
}

/**
 * Bounded retry: at most ONE automatic retry, and only for failures a retry
 * can plausibly fix. Rate limits never retry here — they pause the task.
 */
export async function runAgentBounded(spec: AgentSpec, stream: StreamLog,
  onRetry?: (kind: FailureKind, error: string) => void): Promise<AgentRunResult> {
  if (spec.isCancelled?.()) return cancelledResult(spec);
  const res = await runAgentStreaming(spec, stream);
  if (res.ok || res.rateLimited) return res;
  if (!res.failureKind) return res;
  // A cancelled task must never get a second attempt: the original cancellation
  // bug left a retry running for minutes after the owner clicked Cancel.
  if (spec.isCancelled?.()) return { ...res, cancelled: true };

  onRetry?.(res.failureKind, res.error ?? '');
  const reminder = res.failureKind === 'AGENT_EXECUTION_ERROR' ? ''
    : `\n\nIMPORTANT: your previous reply could not be used (${res.failureKind}). ` +
      'Finish the work, then reply with a single JSON object and nothing else — no prose, no fence. ' +
      `Required keys: ${spec.requiredKeys.join(', ')}.`;
  const second = await runAgentStreaming({ ...spec, prompt: spec.prompt + reminder }, stream);
  return { ...second, attempts: 2, ...(spec.isCancelled?.() ? { cancelled: true } : {}) };
}

/** A run that never started because the task was already cancelling. */
function cancelledResult(spec: AgentSpec): AgentRunResult {
  return {
    ok: false, structured: null, text: '', exitCode: null, durationMs: 0,
    rateLimited: false, failureKind: 'AGENT_EXECUTION_ERROR',
    error: 'task cancelled before this agent started', attempts: 0, usage: null,
    cancelled: true, role: spec.role, provider: spec.agent,
  };
}
