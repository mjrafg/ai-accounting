/**
 * Role-based model selection.
 *
 * Facts verified against the installed CLIs on this host (2026-08-18):
 *   claude 2.1.233 — `--model <alias|full-name>`, `--effort low|medium|high|
 *     xhigh|max` (enumerated by the CLI's own --help); effective model is read
 *     from the stream's message_start event; auth is the subscription login.
 *   codex-cli 0.147.0 — `-m <model>`, `-c model_reasoning_effort=<v>` where
 *     the API itself enumerates none|minimal|low|medium|high|xhigh|max (probed:
 *     an invalid value returns that exact enum in the error). Neither CLI can
 *     list models, so availability is a PROBE result, never a source-code list:
 *     a model is AVAILABLE only after a real subscription-authenticated run
 *     succeeded with it. Effective codex model comes from the session rollout's
 *     turn_context (observed: gpt-5.6-sol).
 *
 * Billing stays SUBSCRIPTION_CLI_ONLY: probes run through the same stripped
 * environment as agents; nothing here can reach a paid API. Provider
 * independence is structural: a role's provider is fixed by the registry, and
 * every setter validates against it — Codex can never review as Claude nor
 * vice versa.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { STATE_ROOT, EventStore } from './store';
import { subscriptionEnv, codexEffectiveModel } from './agents';

const CLAUDE_BIN = process.env.AI_CLAUDE_BIN ?? '/home/aiaccounting/.local/bin/claude';
const CODEX_BIN = process.env.AI_CODEX_BIN ?? '/home/aiaccounting/.nvm/versions/node/v18.16.1/bin/codex';

export type Provider = 'claude' | 'claude-code' | 'codex';

export interface RoleDef { id: string; provider: Provider; group: string; label: string }

/** The registry is the closed set of roles the browser may configure. */
export const ROLES: RoleDef[] = [
  { id: 'claude.design', provider: 'claude', group: 'CLAUDE', label: 'Design & Architecture' },
  { id: 'claude.investigation', provider: 'claude', group: 'CLAUDE', label: 'Bug Investigation' },
  { id: 'claude.adjudication', provider: 'claude', group: 'CLAUDE', label: 'Adjudication' },
  { id: 'claude.report', provider: 'claude', group: 'CLAUDE', label: 'Persian Reports' },
  { id: 'claude.simplify', provider: 'claude', group: 'CLAUDE', label: 'Persian Simplification' },
  { id: 'claudeCode.implementation', provider: 'claude-code', group: 'CLAUDE CODE', label: 'Implementation' },
  { id: 'claudeCode.repair', provider: 'claude-code', group: 'CLAUDE CODE', label: 'Fix / Repair' },
  { id: 'codex.designReview', provider: 'codex', group: 'CODEX', label: 'Design Review' },
  { id: 'codex.codeReview', provider: 'codex', group: 'CODEX', label: 'Code Review' },
  { id: 'codex.investigation', provider: 'codex', group: 'CODEX', label: 'Bug Investigation' },
];

/** Reasoning enums, each taken from the provider's own authoritative source. */
export const REASONING: Record<'claude' | 'codex', string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],           // claude --help --effort
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], // API enum via probe
};
export function reasoningFor(provider: Provider): string[] {
  return provider === 'codex' ? REASONING.codex : REASONING.claude;
}

export type FallbackPolicy = 'best-available' | 'pause' | `backup:${string}`;

export interface RoleSetting { model: string; reasoning: string | null; fallback: FallbackPolicy }
export interface ModelAvailability {
  available: boolean;
  lastChecked: string;
  effectiveModel?: string;
  detail?: string;
}
export interface ProviderStatus {
  cliVersion: string;
  authMode: string;
  connected: boolean;
  models: Record<string, ModelAvailability>;
}
export interface ModelSettings {
  roles: Record<string, RoleSetting>;
  providers: { claude: ProviderStatus; codex: ProviderStatus };
  updatedAt: string;
  updatedBy: string;
}

const FILE = () => path.join(STATE_ROOT, 'settings', 'models.json');

/**
 * Candidates the refresh probe is allowed to test. Presence here means
 * "worth probing", never "available" — only a passing probe grants AVAILABLE.
 */
export const PROBE_CANDIDATES: Record<'claude' | 'codex', string[]> = {
  claude: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  codex: ['gpt-5.6-sol', 'gpt-5.6-codex', 'gpt-5.5-codex', 'gpt-5.2', 'gpt-5.1-codex-max'],
};

/** Verified-at-build seed: models proven working by real V2 runs on this host. */
function seedSettings(): ModelSettings {
  const now = new Date().toISOString();
  const roles: Record<string, RoleSetting> = {};
  for (const r of ROLES) {
    roles[r.id] = {
      model: r.provider === 'codex' ? 'gpt-5.6-sol' : 'claude-fable-5',
      reasoning: null, // provider default until the owner chooses
      fallback: 'best-available',
    };
  }
  return {
    roles,
    providers: {
      claude: {
        cliVersion: 'unknown', authMode: 'subscription-cli', connected: true,
        models: { 'claude-fable-5': { available: true, lastChecked: now, effectiveModel: 'claude-fable-5', detail: 'verified by production task runs' } },
      },
      codex: {
        cliVersion: 'unknown', authMode: 'chatgpt-subscription', connected: true,
        models: { 'gpt-5.6-sol': { available: true, lastChecked: now, effectiveModel: 'gpt-5.6-sol', detail: 'verified by production task runs (session turn_context)' } },
      },
    },
    updatedAt: now, updatedBy: 'system-seed',
  };
}

export function getModelSettings(): ModelSettings {
  try {
    const s = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as ModelSettings;
    // New roles added by upgrades appear with seed defaults, never crash.
    for (const r of ROLES) if (!s.roles[r.id]) s.roles[r.id] = seedSettings().roles[r.id];
    return s;
  } catch {
    return seedSettings();
  }
}

function writeSettings(s: ModelSettings): void {
  const f = FILE();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o750 });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o640 });
  fs.renameSync(tmp, f); // atomic on the same filesystem
}

function roleDef(roleId: string): RoleDef | null {
  return ROLES.find((r) => r.id === roleId) ?? null;
}
function providerKey(p: Provider): 'claude' | 'codex' { return p === 'codex' ? 'codex' : 'claude'; }

function knownModels(s: ModelSettings, provider: Provider): string[] {
  return Object.entries(s.providers[providerKey(provider)].models)
    .filter(([, v]) => v.available).map(([k]) => k);
}

/**
 * The single validated write path for a role. The browser can only reach this
 * with a known role, a probe-verified model of that role's OWN provider, and a
 * reasoning value from that provider's enum — anything else is rejected.
 */
export function setRoleSetting(roleId: string, patch: { model?: string; reasoning?: string | null; fallback?: FallbackPolicy },
  actor: string, events: EventStore): { ok: true } | { ok: false; error: string } {
  const def = roleDef(roleId);
  if (!def) return { ok: false, error: `unknown role: ${roleId}` };
  const s = getModelSettings();
  const cur = s.roles[roleId];
  const next: RoleSetting = { ...cur };

  if (patch.model !== undefined) {
    if (typeof patch.model !== 'string' || !/^[a-z0-9.-]{2,64}$/i.test(patch.model)) {
      return { ok: false, error: 'invalid model identifier' };
    }
    if (!knownModels(s, def.provider).includes(patch.model)) {
      return { ok: false, error: `model not verified available for ${def.provider}: ${patch.model} (use Refresh Models)` };
    }
    next.model = patch.model;
  }
  if (patch.reasoning !== undefined) {
    if (patch.reasoning !== null && !reasoningFor(def.provider).includes(patch.reasoning)) {
      return { ok: false, error: `unsupported reasoning for ${def.provider}: ${patch.reasoning}` };
    }
    next.reasoning = patch.reasoning;
  }
  if (patch.fallback !== undefined) {
    const f = patch.fallback;
    const backupOk = typeof f === 'string' && f.startsWith('backup:') &&
      knownModels(s, def.provider).includes(f.slice('backup:'.length));
    if (f !== 'best-available' && f !== 'pause' && !backupOk) {
      return { ok: false, error: 'fallback must be best-available, pause, or backup:<verified-model>' };
    }
    next.fallback = f;
  }

  const changed = JSON.stringify(cur) !== JSON.stringify(next);
  if (changed) {
    s.roles[roleId] = next;
    s.updatedAt = new Date().toISOString();
    s.updatedBy = actor;
    writeSettings(s);
    events.append({ taskId: 'SYSTEM-SETTINGS', type: 'SETTING_CHANGED', payload: {
      setting: `models.${roleId}`, from: cur, to: next, actor } });
  }
  return { ok: true };
}

/**
 * Presets fill role settings — they never hide per-role configuration. Model
 * choice resolves from CURRENT verified availability, not assumed names.
 */
export const PRESETS = ['maximum-quality', 'balanced', 'faster'] as const;
const CLAUDE_RANK = [/fable/, /opus/, /sonnet/, /haiku/];
function rankClaude(models: string[]): string[] {
  return [...models].sort((a, b) =>
    CLAUDE_RANK.findIndex((re) => re.test(a)) - CLAUDE_RANK.findIndex((re) => re.test(b)));
}
function rankCodex(models: string[]): string[] {
  const ver = (m: string) => parseFloat((/(\d+(?:\.\d+)?)/.exec(m) ?? ['0', '0'])[1]);
  return [...models].sort((a, b) => ver(b) - ver(a));
}
export function applyPreset(preset: string, actor: string, events: EventStore):
  { ok: true; applied: Record<string, RoleSetting> } | { ok: false; error: string } {
  if (!(PRESETS as readonly string[]).includes(preset)) return { ok: false, error: `unknown preset: ${preset}` };
  const s = getModelSettings();
  const claude = rankClaude(knownModels(s, 'claude'));
  const codex = rankCodex(knownModels(s, 'codex'));
  if (!claude.length || !codex.length) return { ok: false, error: 'no verified models to resolve the preset from' };
  const best = { claude: claude[0], codex: codex[0] };
  const fast = { claude: claude[claude.length - 1], codex: codex[codex.length - 1] };

  const pick = (r: RoleDef): RoleSetting => {
    const p = providerKey(r.provider);
    if (preset === 'maximum-quality') {
      return { model: best[p], reasoning: p === 'codex' ? 'xhigh' : 'max', fallback: s.roles[r.id].fallback };
    }
    if (preset === 'faster') {
      return { model: fast[p], reasoning: 'low', fallback: s.roles[r.id].fallback };
    }
    // balanced: strong models for design/adjudication/review, faster for routine work
    const routine = ['claude.report', 'claude.simplify', 'claudeCode.implementation', 'claudeCode.repair'].includes(r.id);
    return { model: routine && claude.length > 1 && p === 'claude' ? claude[Math.min(1, claude.length - 1)] : best[p],
      reasoning: routine ? 'medium' : 'high', fallback: s.roles[r.id].fallback };
  };

  const applied: Record<string, RoleSetting> = {};
  for (const r of ROLES) {
    const to = pick(r);
    // Only reasoning values the provider supports (claude has no 'none' etc.).
    if (to.reasoning && !reasoningFor(r.provider).includes(to.reasoning)) to.reasoning = null;
    applied[r.id] = to;
    const from = s.roles[r.id];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      s.roles[r.id] = to;
      events.append({ taskId: 'SYSTEM-SETTINGS', type: 'SETTING_CHANGED', payload: {
        setting: `models.${r.id}`, from, to, actor, preset } });
    }
  }
  s.updatedAt = new Date().toISOString();
  s.updatedBy = actor;
  writeSettings(s);
  return { ok: true, applied };
}

// ---------------------------------------------------------------------------
// Resolution: role → concrete execution parameters
// ---------------------------------------------------------------------------

export interface ResolvedRole { role: string; provider: Provider; model: string; reasoning: string | null; fallback: FallbackPolicy }

/**
 * Resolves the FULL policy map, optionally with validated per-task overrides.
 * The result is what gets snapshotted immutably into TASK_MODEL_POLICY.
 */
export function resolvePolicy(overrides?: Record<string, { model?: string; reasoning?: string | null }>):
  { ok: true; policy: Record<string, ResolvedRole> } | { ok: false; error: string } {
  const s = getModelSettings();
  const policy: Record<string, ResolvedRole> = {};
  for (const r of ROLES) {
    const base = s.roles[r.id];
    const o = overrides?.[r.id];
    let model = base.model, reasoning = base.reasoning;
    if (o?.model !== undefined) {
      if (!knownModels(s, r.provider).includes(o.model)) {
        return { ok: false, error: `override for ${r.id}: model not verified available: ${o.model}` };
      }
      model = o.model;
    }
    if (o?.reasoning !== undefined) {
      if (o.reasoning !== null && !reasoningFor(r.provider).includes(o.reasoning)) {
        return { ok: false, error: `override for ${r.id}: unsupported reasoning: ${o.reasoning}` };
      }
      reasoning = o.reasoning;
    }
    policy[r.id] = { role: r.id, provider: r.provider, model, reasoning, fallback: base.fallback };
  }
  return { ok: true, policy };
}

/**
 * Model-unavailable behavior: same provider ALWAYS. Returns the substitute
 * model, 'pause', or null (no viable substitute → pause is forced anyway).
 */
export function fallbackFor(role: ResolvedRole): { action: 'model'; model: string } | { action: 'pause' } {
  if (role.fallback === 'pause') return { action: 'pause' };
  const s = getModelSettings();
  if (typeof role.fallback === 'string' && role.fallback.startsWith('backup:')) {
    const backup = role.fallback.slice('backup:'.length);
    if (knownModels(s, role.provider).includes(backup) && backup !== role.model) return { action: 'model', model: backup };
    return { action: 'pause' };
  }
  // best-available within the SAME provider, excluding the failed model
  const ranked = role.provider === 'codex'
    ? rankCodex(knownModels(s, 'codex')) : rankClaude(knownModels(s, 'claude'));
  const next = ranked.find((m) => m !== role.model);
  return next ? { action: 'model', model: next } : { action: 'pause' };
}

// ---------------------------------------------------------------------------
// Availability probes — server-owned commands only; nothing browser-supplied
// ---------------------------------------------------------------------------

const MODEL_ID = /^[a-z0-9.-]{2,64}$/i;

function execAsync(bin: string, args: string[], timeout: number, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(bin, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env },
      (err, out) => resolve(err && !out ? null : String(out ?? '')));
    child.stdin?.end();
  });
}

async function probeClaude(model: string): Promise<ModelAvailability> {
  const now = new Date().toISOString();
  if (!MODEL_ID.test(model)) return { available: false, lastChecked: now, detail: 'invalid identifier' };
  const out = await execAsync(CLAUDE_BIN,
    ['-p', 'Reply with exactly: OK', '--model', model, '--output-format', 'json'],
    120_000, subscriptionEnv());
  if (!out) return { available: false, lastChecked: now, detail: 'probe failed (non-zero exit)' };
  try {
    const o = JSON.parse(out);
    if (o.is_error) return { available: false, lastChecked: now, detail: String(o.result ?? 'error').slice(0, 160) };
    const eff = Object.keys(o.modelUsage ?? {}).find((k) => !/haiku/.test(k)) ??
      Object.keys(o.modelUsage ?? {})[0];
    return { available: true, lastChecked: now, effectiveModel: eff, detail: 'probe ok' };
  } catch (e: any) {
    return { available: false, lastChecked: now, detail: String(e?.message ?? e).slice(0, 160) };
  }
}

async function probeCodex(model: string): Promise<ModelAvailability> {
  const now = new Date().toISOString();
  if (!MODEL_ID.test(model)) return { available: false, lastChecked: now, detail: 'invalid identifier' };
  const out = await execAsync(CODEX_BIN,
    ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '-m', model, 'Reply with exactly: OK'],
    180_000, { ...subscriptionEnv(), PATH: `${path.dirname(CODEX_BIN)}:/usr/bin:/bin` });
  if (out === null) return { available: false, lastChecked: now, detail: 'probe failed (non-zero exit)' };
  let completed = false, metadataMissing = false, errDetail = '';
  let threadId = '';
  for (const line of out.split('\n')) {
    let ev: any; try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type === 'thread.started') threadId = String(ev.thread_id ?? '');
    if (ev?.type === 'turn.completed') completed = true;
    if (ev?.type === 'error') {
      const msg = String(ev.message ?? '');
      if (/Model metadata for .* not found/i.test(msg)) metadataMissing = true;
      else errDetail = msg.slice(0, 160);
    }
    if (ev?.type === 'turn.failed') errDetail = String(ev?.error?.message ?? 'turn failed').slice(0, 160);
  }
  if (!completed) return { available: false, lastChecked: now, detail: errDetail || 'no turn.completed' };
  if (metadataMissing) return { available: false, lastChecked: now, detail: 'CLI has no metadata for this model (not a real current model)' };
  const eff = codexEffectiveModel(threadId) ?? model;
  return { available: true, lastChecked: now, effectiveModel: eff, detail: 'probe ok' };
}

function cliVersion(bin: string, viaNodePath = false): string {
  try {
    const env = viaNodePath ? { ...process.env, PATH: `${path.dirname(bin)}:/usr/bin:/bin` } : process.env;
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, env }).trim();
  } catch { return 'unknown'; }
}

/**
 * Owner-triggered availability refresh. Probes every candidate plus every
 * model currently referenced by a role setting. Spends a few subscription
 * tokens per model — always an explicit owner action, never automatic.
 *
 * Fully async and serialized: probes run one at a time off the request path so
 * a multi-minute refresh never blocks the event loop (SSE, live tasks). The
 * server returns immediately; the UI polls GET until updatedAt moves.
 */
let refreshInFlight = false;
export function isRefreshing(): boolean { return refreshInFlight; }

export async function refreshAvailability(actor: string, events: EventStore): Promise<ModelSettings> {
  if (refreshInFlight) return getModelSettings();
  refreshInFlight = true;
  try {
    const s = getModelSettings();
    const claudeSet = new Set(PROBE_CANDIDATES.claude);
    const codexSet = new Set(PROBE_CANDIDATES.codex);
    for (const r of ROLES) {
      const m = s.roles[r.id]?.model;
      if (m) (r.provider === 'codex' ? codexSet : claudeSet).add(m);
    }

    s.providers.claude.cliVersion = cliVersion(CLAUDE_BIN);
    s.providers.codex.cliVersion = cliVersion(CODEX_BIN, true);
    for (const m of claudeSet) s.providers.claude.models[m] = await probeClaude(m);
    for (const m of codexSet) s.providers.codex.models[m] = await probeCodex(m);
    s.providers.claude.connected = Object.values(s.providers.claude.models).some((v) => v.available);
    s.providers.codex.connected = Object.values(s.providers.codex.models).some((v) => v.available);
    s.updatedAt = new Date().toISOString();
    s.updatedBy = actor;
    writeSettings(s);
    events.append({ taskId: 'SYSTEM-SETTINGS', type: 'NOTE', payload: {
      modelAvailabilityRefreshed: {
        actor,
        claude: Object.fromEntries(Object.entries(s.providers.claude.models).map(([k, v]) => [k, v.available])),
        codex: Object.fromEntries(Object.entries(s.providers.codex.models).map(([k, v]) => [k, v.available])),
      } } });
    return s;
  } finally {
    refreshInFlight = false;
  }
}

/** Test-only: inject availability without probing (never used by the server routes). */
export function __setAvailabilityForTest(provider: 'claude' | 'codex', model: string, available: boolean): void {
  const s = getModelSettings();
  s.providers[provider].models[model] = { available, lastChecked: new Date().toISOString(), detail: 'test-injected' };
  writeSettings(s);
}
