/**
 * AI Control Center V2 — HTTP + SSE control plane.
 *
 * Dependency-free (node:http). Same security posture as V1, hardened further:
 * fixed verb set, no shell passthrough, textContent-only client, secrets
 * redacted before persistence and before the wire, per-endpoint rate limits,
 * TOTP MFA on sensitive approvals once enrolled.
 */
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { EventStore, StreamLog, deriveTask, currentDesign, allFindings, STATE_ROOT } from './core/store';
import { Orchestrator } from './core/orchestrator';
import { loadKnownSecrets, redact } from './core/redact';
import { bannedKeysPresent, BILLING_MODE } from './core/agents';
import { mfaStatus, mfaBeginEnroll, mfaConfirmEnroll, mfaCheck } from './core/mfa';
import { stageMinus1Lock, deployLock } from './core/checks';
import { getDeploymentSettings, setAutomaticDeployment } from './core/settings';
import { generateReport, listReports, whatChanged } from './core/report';
import {
  ROLES, REASONING, PRESETS, getModelSettings, setRoleSetting, applyPreset, refreshAvailability, isRefreshing,
} from './core/models';
import { TaskRecord } from './core/types';

const HOST = process.env.AI_BIND_HOST ?? '172.17.0.1';
const PORT = Number(process.env.AI_V2_PORT ?? 8788);
const CONF_DIR = process.env.AI_CONF ?? '/etc/ai-accounting';
const OWNER_FILE = path.join(CONF_DIR, 'owner.json');
const SESSION_FILE = path.join(STATE_ROOT, 'sessions.json');
const V1_STATE = process.env.AI_V1_STATE ?? '/srv/ai-accounting/state/ai';
const COOKIE = 'ai_cc2_session';
const SESSION_TTL = 12 * 3600_000;

// Redaction learns the machine's real secret values before anything streams.
const redactCount = loadKnownSecrets([
  '/etc/ai-accounting/production/prod.env',
  '/srv/ai-accounting/repo/.env',
  path.join(CONF_DIR, 'owner.json'),
]);

const events = new EventStore();
const stream = new StreamLog();
const orch = new Orchestrator(events, stream);
const HTML = fs.readFileSync(path.join(__dirname, 'ui', 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Sessions + auth (same owner credential as V1; separate session namespace)
// ---------------------------------------------------------------------------

function readOwner(): any { try { return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')); } catch { return null; } }
function hashPassword(pw: string, salt: string): string {
  return crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

let sessions = new Map<string, { user: string; csrf: string; expires: number }>();
function loadSessions(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    sessions = new Map(Object.entries(raw).filter(([, v]: any) => v.expires > Date.now())) as any;
  } catch { sessions = new Map(); }
}
function saveSessions(): void {
  const obj: Record<string, unknown> = {};
  for (const [k, v] of sessions) if (v.expires > Date.now()) obj[k] = v;
  fs.mkdirSync(STATE_ROOT, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(obj), { mode: 0o600 });
}
loadSessions();

function sessionFrom(req: http.IncomingMessage) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie ?? '');
  if (!m) return null;
  let s = sessions.get(m[1]);
  if (!s) { loadSessions(); s = sessions.get(m[1]); }
  return s && s.expires > Date.now() ? { id: m[1], ...s } : null;
}

// ---------------------------------------------------------------------------
// Rate limits, separated by endpoint class
// ---------------------------------------------------------------------------

const buckets = new Map<string, { count: number; first: number }>();
function limited(key: string, max: number, windowMs: number): boolean {
  const b = buckets.get(key);
  const now = Date.now();
  if (!b || now - b.first > windowMs) { buckets.set(key, { count: 1, first: now }); return false; }
  b.count += 1;
  return b.count > max;
}
const LIMITS: Record<string, [number, number]> = {
  login: [8, 15 * 60_000], mfa: [10, 15 * 60_000], merge: [6, 10 * 60_000],
  deploy: [4, 10 * 60_000], write: [60, 60_000], read: [600, 60_000],
};
function rateGate(cls: keyof typeof LIMITS, ip: string): boolean {
  const [max, win] = LIMITS[cls];
  return limited(`${cls}:${ip}`, max, win);
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function projectTask(taskId: string) {
  const rec = deriveTask(events, taskId);
  if (!rec) return null;
  const evs = events.read(taskId);
  const design = currentDesign(events, taskId);
  const designRevisions = evs.filter((e) => e.type === 'DESIGN_REVISION')
    .map((e) => ({ revision: (e.payload as any).design.revision, ts: e.ts, applied: (e.payload as any).design.appliedFindings }));
  const findings = allFindings(events, taskId);
  const tests = evs.filter((e) => e.type === 'TEST_RESULT').map((e) => ({ ...(e.payload as any), ts: e.ts }));
  const checksEv = evs.filter((e) => e.type === 'DETERMINISTIC_CHECK').map((e) => ({ ...(e.payload as any), ts: e.ts }));
  const evidence = evs.filter((e) => e.type === 'EVIDENCE').map((e) => e.payload as any);
  const agents = evs.filter((e) => ['AGENT_STARTED', 'AGENT_FINISHED', 'AGENT_FAILED'].includes(e.type))
    .map((e) => ({ type: e.type, agent: e.agent, phase: e.phase, ts: e.ts, ...(e.payload as any) }));
  const merge = evs.filter((e) => e.type === 'MERGE_RESULT').map((e) => e.payload as any).pop() ?? null;
  const deploy = evs.filter((e) => e.type === 'DEPLOY_RESULT').map((e) => e.payload as any).pop() ?? null;
  const verified: string[] = []; const notVerified: string[] = [];
  for (const ev of evidence) {
    for (const v of ev.verified ?? []) verified.push(String(v));
    for (const v of ev.notVerified ?? []) notVerified.push(String(v));
  }
  const modelPolicy = evs.filter((e) => e.type === 'TASK_MODEL_POLICY').map((e) => e.payload as any).pop() ?? null;
  return {
    ...rec, design, designRevisions, findings, tests, checks: checksEv, agents, merge, deploy,
    modelPolicy,
    verified, notVerified,
    eventCount: evs.length,
    history: evs.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, agent: e.agent, phase: e.phase,
      summary: JSON.stringify(e.payload).slice(0, 160) })),
    elapsedMs: Date.now() - Date.parse(rec.createdAt),
  };
}

function legacyTasks() {
  const dir = path.join(V1_STATE, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl'))).sort().map((id) => {
    const lines = fs.readFileSync(path.join(dir, id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean);
    let title = id, state = 'UNKNOWN';
    try {
      const first = JSON.parse(lines[0]);
      title = String(first.payload?.title ?? id).split('\\n')[0].slice(0, 100);
      for (const l of lines) {
        const e = JSON.parse(l);
        if (e.type === 'STATE_TRANSITION') state = e.payload.to;
        if (e.type === 'READY_TO_MERGE') state = 'READY_TO_MERGE';
        if (e.type === 'ESCALATION') state = 'ESCALATED';
        if (e.type === 'TASK_CANCELLED') state = 'CANCELLED';
      }
    } catch { /* legacy quirks */ }
    return { taskId: id, title, state, legacy: 'V1 LEGACY', events: lines.length };
  });
}

function observatory() {
  const ids = events.listTasks().filter((id) => /^TASK-V2-\d+$/.test(id));
  const tasks = ids.map((id) => {
    const evs = events.read(id);
    return {
      taskId: id,
      provenance: 'LIVE EVIDENCE',
      findings: evs.filter((e) => e.type === 'FINDING').reduce((n, e) => n + ((e.payload as any).findings?.length ?? 0), 0),
      adjudications: evs.filter((e) => e.type === 'ADJUDICATION').length,
      deterministicOverrules: evs.filter((e) => e.type === 'ADJUDICATION' && /DETERMINISTICALLY/.test(String((e.payload as any).status))).length,
      state: deriveTask(events, id)?.state,
    };
  });
  return {
    sampleSize: ids.length,
    note: ids.length < 30 ? `SAMPLE SIZE: ${ids.length} — raw counts only; percentages withheld below N=30` : null,
    tasks,
    legacy: legacyTasks().length,
  };
}

function sh(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('bash', ['-c', cmd], { timeout: 15_000 }, (e, so) => resolve((so ?? '').trim()));
  });
}

async function systemStatus() {
  const [prodHealth, disk, v2sha] = await Promise.all([
    sh('docker ps --filter name=bigcapital-prod --format "{{.Names}}:{{.Status}}" | head -8'),
    sh("df -h / | tail -1 | awk '{print $4\" free of \"$2}'"),
    sh('git -C /srv/ai-accounting/repo rev-parse --short HEAD 2>/dev/null'),
  ]);
  return {
    version: 'v2', sha: v2sha, billingMode: BILLING_MODE,
    paidApiKeys: bannedKeysPresent(),
    claude: fs.existsSync('/home/aiaccounting/.claude') ? 'authenticated (subscription)' : 'unknown',
    codex: fs.existsSync('/home/aiaccounting/.codex') ? 'authenticated (subscription)' : 'unknown',
    stage1Lock: stageMinus1Lock.holder(),
    mfa: mfaStatus(),
    deployment: { ...getDeploymentSettings(), activeDeployment: deployLock.holder() },
    redactionRules: redactCount,
    production: prodHealth.split('\n').filter(Boolean),
    disk, memory: `${Math.round(os.freemem() / 2 ** 30)}G free of ${Math.round(os.totalmem() / 2 ** 30)}G`,
    load: os.loadavg().map((n) => n.toFixed(2)).join(' '),
    stateRoot: STATE_ROOT,
    activeTasks: events.listTasks().map((id) => deriveTask(events, id))
      .filter((t): t is TaskRecord => Boolean(t))
      .filter((t) => !['DEPLOYED', 'CANCELLED', 'FAILED', 'ESCALATED'].includes(t.state))
      .map((t) => t.taskId),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 256 * 1024) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('bad json')); } });
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    process.stderr.write(`request failed: ${req.method} ${req.url}: ${err?.stack ?? err}\n`);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else try { res.end(); } catch { /* gone */ }
  });
});
process.on('uncaughtException', (e) => process.stderr.write(`uncaught: ${e?.stack ?? e}\n`));
process.on('unhandledRejection', (e: any) => process.stderr.write(`unhandled: ${e?.stack ?? e}\n`));

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '?').split(',')[0].trim();

  if (p === '/healthz') return json(res, 200, { ok: true, v: 2 });

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000',
    });
    return void res.end(HTML);
  }

  const owner = readOwner();

  if (p === '/api/v2/session' && req.method === 'GET') {
    const s = sessionFrom(req);
    return json(res, 200, { authenticated: Boolean(s), user: s?.user ?? null, csrf: s?.csrf ?? null,
      setupRequired: !owner, mfa: mfaStatus(), version: 'v2' });
  }

  if (p === '/api/v2/login' && req.method === 'POST') {
    if (rateGate('login', ip)) return json(res, 429, { error: 'too many attempts' });
    if (!owner) return json(res, 409, { error: 'owner not set up (use V1 setup first)' });
    const body = await readBody(req);
    const got = Buffer.from(hashPassword(String(body.password ?? ''), owner.salt), 'hex');
    const want = Buffer.from(owner.hash, 'hex');
    const ok = String(body.username ?? '') === owner.username &&
      got.length === want.length && crypto.timingSafeEqual(got, want);
    if (!ok) return json(res, 401, { error: 'invalid credentials' });
    const id = crypto.randomBytes(32).toString('hex');
    const csrf = crypto.randomBytes(32).toString('hex');
    sessions.set(id, { user: owner.username, csrf, expires: Date.now() + SESSION_TTL });
    saveSessions();
    res.writeHead(200, { 'content-type': 'application/json',
      'set-cookie': `${COOKIE}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
    return void res.end(JSON.stringify({ ok: true, csrf }));
  }

  const sess = sessionFrom(req);
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!sess) return json(res, 401, { error: 'authentication required' });

  if (req.method === 'POST' && p !== '/api/v2/logout' &&
      req.headers['x-csrf-token'] !== sess.csrf) {
    return json(res, 403, { error: 'csrf token mismatch' });
  }
  if (req.method === 'GET' && p !== '/api/v2/events' && rateGate('read', ip)) {
    return json(res, 429, { error: 'rate limited' });
  }

  if (p === '/api/v2/logout' && req.method === 'POST') {
    sessions.delete(sess.id); saveSessions();
    res.writeHead(200, { 'content-type': 'application/json',
      'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
    return void res.end('{"ok":true}');
  }

  // ---- MFA ---------------------------------------------------------------
  if (p === '/api/v2/mfa/enroll' && req.method === 'POST') {
    if (rateGate('mfa', ip)) return json(res, 429, { error: 'rate limited' });
    return json(res, 200, mfaBeginEnroll(sess.user));
  }
  if (p === '/api/v2/mfa/confirm' && req.method === 'POST') {
    if (rateGate('mfa', ip)) return json(res, 429, { error: 'rate limited' });
    const body = await readBody(req);
    return json(res, mfaConfirmEnroll(String(body.code ?? '')) ? 200 : 400,
      { ...mfaStatus() });
  }

  // ---- Tasks -------------------------------------------------------------
  if (p === '/api/v2/tasks' && req.method === 'GET') {
    return json(res, 200, {
      tasks: events.listTasks().map(projectTask).filter(Boolean).reverse(),
      legacy: legacyTasks().reverse(),
    });
  }
  if (p === '/api/v2/tasks' && req.method === 'POST') {
    if (rateGate('write', ip)) return json(res, 429, { error: 'rate limited' });
    const body = await readBody(req);
    const description = String(body.description ?? '').trim().slice(0, 8000);
    const risk = ['low', 'medium', 'high'].includes(body.risk) ? body.risk : 'high';
    if (!description) return json(res, 400, { error: 'a description is required' });
    // Optional per-task model overrides: role keys must exist in the registry;
    // values are validated (model must be probe-verified) inside resolvePolicy.
    let overrides: Record<string, { model?: string; reasoning?: string | null }> | undefined;
    if (body.modelOverrides && typeof body.modelOverrides === 'object') {
      overrides = {};
      for (const [k, v] of Object.entries(body.modelOverrides as Record<string, any>)) {
        if (!ROLES.some((r) => r.id === k)) return json(res, 400, { error: `unknown role in modelOverrides: ${k}` });
        if (!v || typeof v !== 'object') return json(res, 400, { error: `override for ${k} must be an object` });
        overrides[k] = {
          ...(typeof v.model === 'string' ? { model: v.model } : {}),
          ...('reasoning' in v ? { reasoning: v.reasoning === null ? null : String(v.reasoning) } : {}),
        };
      }
      if (!Object.keys(overrides).length) overrides = undefined;
    }
    let rec;
    try { rec = orch.createTask(description, risk, { modelOverrides: overrides }); }
    catch (e: any) { return json(res, 400, { error: String(e?.message ?? e) }); }
    // Fire-and-forget: the pipeline streams its progress; the UI watches live.
    orch.run(rec.taskId).catch(() => undefined);
    return json(res, 200, { ok: true, taskId: rec.taskId });
  }

  const tm = /^\/api\/v2\/tasks\/(TASK-V2-\d+)(?:\/([\w-]+))?$/.exec(p);
  if (tm) {
    const [, taskId, action] = tm;
    if (req.method === 'GET' && !action) {
      const t = projectTask(taskId);
      return t ? json(res, 200, t) : json(res, 404, { error: 'unknown task' });
    }
    if (req.method === 'GET' && action === 'diff') {
      const rec = deriveTask(events, taskId);
      if (!rec) return json(res, 404, { error: 'unknown task' });
      const diff = fs.existsSync(rec.worktree) ? orch.wtm.diff(rec.worktree, rec.baseSha) : '(worktree absent)';
      return json(res, 200, { diff: redact(diff).slice(0, 500_000) });
    }
    if (req.method === 'GET' && action === 'stream') return sse(req, res, taskId);
    if (req.method === 'POST') {
      if (rateGate('write', ip)) return json(res, 429, { error: 'rate limited' });
      if (action === 'resume') {
        const rec0 = deriveTask(events, taskId);
        if (rec0?.state === 'ESCALATED' || rec0?.state === 'PAUSED') orch.retryFromEscalation(taskId, sess.user);
        orch.run(taskId).catch(() => undefined);
        return json(res, 200, { ok: true });
      }
      if (action === 'update-models') {
        // Explicit owner action: re-snapshot this task's model policy from
        // current defaults. Never automatic; running agents are unaffected.
        const ok = orch.updateTaskModels(taskId, sess.user);
        return json(res, ok ? 200 : 409, { ok });
      }
      if (action === 'cancel') {
        const body = await readBody(req);
        orch.cancel(taskId, sess.user, String(body.reason ?? 'cancelled by owner'));
        return json(res, 200, { ok: true });
      }
      if (action === 'decision') {
        const body = await readBody(req);
        const mfa = mfaCheck(body.mfaCode);
        if (!mfa.ok) return json(res, 403, { error: mfa.reason });
        const ok = orch.resolveHumanDecision(taskId, String(body.decisionId ?? ''), String(body.choice ?? ''), sess.user);
        if (ok) orch.run(taskId).catch(() => undefined);
        return json(res, ok ? 200 : 409, { ok });
      }
      if (action === 'approve-merge') {
        if (rateGate('merge', ip)) return json(res, 429, { error: 'rate limited' });
        const body = await readBody(req);
        const mfa = mfaCheck(body.mfaCode);
        if (!mfa.ok) return json(res, 403, { error: mfa.reason });
        const rec = deriveTask(events, taskId);
        if (!rec) return json(res, 404, { error: 'unknown task' });
        // The browser submits the SHA the human reviewed; the server verifies it
        // against reviewed HEAD and branch HEAD before anything merges.
        const r = orch.performMerge(taskId, rec, String(body.approvedSha ?? ''), sess.user);
        if (r.ok) orch.run(taskId).catch(() => undefined);
        return json(res, r.ok ? 200 : 409, r);
      }
      if (action === 'approve-deploy') {
        if (rateGate('deploy', ip)) return json(res, 429, { error: 'rate limited' });
        const body = await readBody(req);
        const mfa = mfaCheck(body.mfaCode);
        if (!mfa.ok) return json(res, 403, { error: mfa.reason });
        const r = orch.performDeploy(taskId, sess.user);
        return json(res, r.ok ? 200 : 409, r);
      }
    }
  }

  // ---- Persian reports (observational side-channel; V2 and V1-legacy) ----
  // Narrow by construction: fixed actions over the canonical snapshot only —
  // no free-form prompts and no shell reach the model from here.
  const rm = /^\/api\/v2\/tasks\/(TASK(?:-V2)?-\d+)\/reports(?:\/([\w-]+))?$/.exec(p);
  if (rm) {
    const [, rTaskId, rAction] = rm;
    if (req.method === 'GET' && !rAction) {
      return json(res, 200, { reports: listReports(rTaskId) });
    }
    if (req.method === 'POST' && rAction) {
      if (rateGate('write', ip)) return json(res, 429, { error: 'rate limited' });
      if (['persian', 'simplify', 'refresh'].includes(rAction)) {
        const level = rAction === 'simplify' ? 'SIMPLE' as const : 'NORMAL' as const;
        // Refresh is the one explicit owner request to regenerate even when the
        // evidence cursor is unchanged (e.g. to retry after a fallback report).
        const r = await generateReport(events, rTaskId, level, { force: rAction === 'refresh' });
        return r ? json(res, 200, r) : json(res, 404, { error: 'unknown task' });
      }
      if (rAction === 'what-changed') {
        const body = await readBody(req);
        const since = Number(body.sinceCursor);
        if (!Number.isInteger(since) || since < 0) return json(res, 400, { error: 'sinceCursor (integer) is required' });
        return json(res, 200, { text: whatChanged(events, rTaskId, since) });
      }
    }
    return json(res, 404, { error: 'not found' });
  }

  // ---- AI model settings (role-based; closed-world validation) -----------
  if (p === '/api/v2/settings/models' && req.method === 'GET') {
    return json(res, 200, {
      roles: ROLES, reasoning: REASONING, presets: PRESETS,
      refreshing: isRefreshing(),
      settings: getModelSettings(),
    });
  }
  if (p === '/api/v2/settings/models' && (req.method === 'PATCH' || req.method === 'POST')) {
    if (rateGate('write', ip)) return json(res, 429, { error: 'rate limited' });
    if (req.headers['x-csrf-token'] !== sess.csrf) return json(res, 403, { error: 'csrf token mismatch' });
    const body = await readBody(req);
    // Two shapes only: {preset} or {role, model?, reasoning?, fallback?}.
    // Everything is validated against the closed registry — the browser can
    // never smuggle CLI arguments, env vars, or shell through here.
    if (typeof body.preset === 'string') {
      const r = applyPreset(body.preset, sess.user, events);
      return r.ok ? json(res, 200, { ok: true, applied: r.applied, settings: getModelSettings() })
        : json(res, 400, { error: r.error });
    }
    if (typeof body.role !== 'string') return json(res, 400, { error: 'role or preset is required' });
    const patch: any = {};
    if ('model' in body) patch.model = body.model;
    if ('reasoning' in body) patch.reasoning = body.reasoning === null ? null : String(body.reasoning);
    if ('fallback' in body) patch.fallback = body.fallback;
    const r = setRoleSetting(body.role, patch, sess.user, events);
    return r.ok ? json(res, 200, { ok: true, settings: getModelSettings() }) : json(res, 400, { error: r.error });
  }
  if (p === '/api/v2/settings/models/refresh' && req.method === 'POST') {
    // Probes spend a few subscription tokens per candidate — deploy-class rate.
    if (rateGate('deploy', ip)) return json(res, 429, { error: 'rate limited' });
    if (req.headers['x-csrf-token'] !== sess.csrf) return json(res, 403, { error: 'csrf token mismatch' });
    if (isRefreshing()) return json(res, 202, { ok: true, running: true });
    // Runs in the background (serialized, async probes); the UI polls GET.
    refreshAvailability(sess.user, events).catch(() => undefined);
    return json(res, 202, { ok: true, started: true });
  }

  // ---- Deployment settings (boolean toggle; separately audited) ----------
  if (p === '/api/v2/settings/deployment' && req.method === 'GET') {
    return json(res, 200, {
      ...getDeploymentSettings(),
      // A deploy already executing is never killed by the toggle; it finishes
      // its transaction (including rollback) safely.
      activeDeployment: deployLock.holder(),
      readyToDeploy: orch.readyToDeployTasks(),
    });
  }
  if (p === '/api/v2/settings/deployment' && (req.method === 'PATCH' || req.method === 'POST')) {
    if (rateGate('deploy', ip)) return json(res, 429, { error: 'rate limited' });
    if (req.headers['x-csrf-token'] !== sess.csrf) return json(res, 403, { error: 'csrf token mismatch' });
    const body = await readBody(req);
    if (typeof body.automaticProductionDeployment !== 'boolean') {
      return json(res, 400, { error: 'automaticProductionDeployment must be a boolean' });
    }
    const change = setAutomaticDeployment(body.automaticProductionDeployment, sess.user);
    // Immutable audit record — actor is the authenticated session user.
    events.append({
      taskId: 'SYSTEM-SETTINGS', type: 'SETTING_CHANGED', payload: {
        setting: 'automaticProductionDeployment',
        from: change.from, to: change.to, actor: sess.user,
      },
    });
    const continued: string[] = [];
    if (change.to && body.continueReadyTasks !== false) {
      for (const id of orch.readyToDeployTasks()) {
        continued.push(id);
        orch.run(id).catch(() => undefined);
      }
    }
    return json(res, 200, { ...getDeploymentSettings(), continued });
  }

  if (p === '/api/v2/observatory' && req.method === 'GET') return json(res, 200, observatory());
  if (p === '/api/v2/system' && req.method === 'GET') return json(res, 200, await systemStatus());

  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// SSE with Last-Event-ID replay from the durable stream log
// ---------------------------------------------------------------------------

function sse(req: http.IncomingMessage, res: http.ServerResponse, taskId: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-store',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  });
  const url = new URL(req.url ?? '/', 'http://x');
  const lastRaw = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? '0';
  const after = Number.parseInt(String(lastRaw), 10) || 0;

  res.write(`event: hello\ndata: {"taskId":"${taskId}"}\n\n`);
  // Replay history after the cursor, then continue live. Ids are assigned once
  // at append time, so replay+live cannot duplicate or reorder.
  for (const c of stream.replay(taskId, after)) {
    res.write(`id: ${c.id}\nevent: chunk\ndata: ${JSON.stringify(c)}\n\n`);
  }
  const onChunk = (c: any) => { try { res.write(`id: ${c.id}\nevent: chunk\ndata: ${JSON.stringify(c)}\n\n`); } catch { /* gone */ } };
  stream.on(`chunk:${taskId}`, onChunk);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* gone */ } }, 25_000);
  req.on('close', () => { clearInterval(ka); stream.off(`chunk:${taskId}`, onChunk); });
}

// ---------------------------------------------------------------------------

server.listen(PORT, HOST, () => {
  process.stdout.write(`ai-control-center-v2 on ${HOST}:${PORT} state=${STATE_ROOT} redaction=${redactCount} known values\n`);
  // Crash/restart recovery: resumable tasks continue where the log left them.
  for (const id of events.listTasks()) {
    const t = deriveTask(events, id);
    if (t && ['DESIGN', 'IMPLEMENT', 'VERIFY', 'REVIEW', 'FIX', 'FINAL_ACCEPTANCE'].includes(t.state)) {
      stream.append(id, 'system', 'lifecycle', 'service restarted — resuming from recorded state');
      orch.run(id).catch(() => undefined);
    }
  }
});
