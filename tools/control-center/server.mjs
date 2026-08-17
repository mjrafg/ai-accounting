/**
 * AI Control Center — HTTP control plane for the Autopilot.
 *
 * Deliberately dependency-free (node:http + node:crypto). The repo's policy
 * engine treats new dependencies as an escalation, and a single-owner control
 * plane does not need a framework.
 *
 * Security posture:
 *   - Never executes arbitrary commands. The API exposes a fixed verb set that
 *     maps onto the Autopilot CLI; there is no shell passthrough anywhere.
 *   - Binds to a private address only; TLS and the public hostname are the
 *     reverse proxy's job.
 *   - Agent output is untrusted text. Nothing is ever rendered as HTML: the
 *     client builds DOM with textContent only, and the API ships JSON.
 *   - The Autopilot event log is the single source of truth. This process keeps
 *     no second task database that could disagree with it.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';

const REPO = process.env.AI_REPO ?? '/srv/ai-accounting/repo';
const AI_DIR = path.join(REPO, '.ai');
const STATE_DIR = process.env.AI_STATE ?? '/srv/ai-accounting/state';
const CONF_DIR = process.env.AI_CONF ?? '/etc/ai-accounting';
const HOST = process.env.AI_BIND_HOST ?? '127.0.0.1';
const PORT = Number(process.env.AI_BIND_PORT ?? 8787);
const PUBLIC_URL = process.env.AI_PUBLIC_URL ?? 'https://ai.agent24.io';
const ENVIRONMENT = process.env.AI_ENVIRONMENT ?? 'TEST / DEVELOPMENT';
const ACCOUNTING_URL = process.env.AI_ACCOUNTING_URL ?? 'https://acc.agent24.io';

const HTML = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'index.html'), 'utf8');

// ---------------------------------------------------------------------------
// Owner credential + sessions
// ---------------------------------------------------------------------------

const OWNER_FILE = path.join(CONF_DIR, 'owner.json');
const SESSION_FILE = path.join(STATE_DIR, 'sessions.json');
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = 'ai_cc_session'; // distinct from the accounting app's cookies

function readOwner() {
  if (!fs.existsSync(OWNER_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function verifyPassword(password, owner) {
  const got = Buffer.from(hashPassword(password, owner.salt), 'hex');
  const want = Buffer.from(owner.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

let sessions = new Map();
function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    sessions = new Map(Object.entries(raw).filter(([, v]) => v.expires > Date.now()));
  } catch {
    sessions = new Map();
  }
}
function saveSessions() {
  const obj = {};
  for (const [k, v] of sessions) if (v.expires > Date.now()) obj[k] = v;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify(obj), { mode: 0o600 });
}
loadSessions();

function newSession(user) {
  const id = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { user, csrf, expires: Date.now() + SESSION_TTL_MS });
  saveSessions();
  return { id, csrf };
}

function sessionFrom(req) {
  const raw = req.headers.cookie ?? '';
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(raw);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) return null;
  return { id: m[1], ...s };
}

// Login throttling, per source address.
const attempts = new Map();
function throttled(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) {
    attempts.delete(ip);
    return false;
  }
  return a.count >= 8;
}
function noteAttempt(ip, ok) {
  if (ok) return attempts.delete(ip);
  const a = attempts.get(ip) ?? { count: 0, first: Date.now() };
  a.count += 1;
  attempts.set(ip, a);
}

// ---------------------------------------------------------------------------
// Autopilot projection — read the immutable event log, never a second store
// ---------------------------------------------------------------------------

function taskIds() {
  const dir = path.join(AI_DIR, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl'))).sort();
}

function readEvents(taskId) {
  const p = path.join(AI_DIR, 'tasks', taskId, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const PHASES = [
  ['Claude design', ['DESIGNING']],
  ['Codex design review', ['DESIGN_REVIEW']],
  ['Claude adjudication', ['DESIGN_ADJUDICATION']],
  ['Claude Code implementation', ['IMPLEMENTING']],
  ['Tests', ['TESTING']],
  ['Pre-review acceptance', ['PRE_REVIEW_ACCEPTANCE']],
  ['Codex implementation review', ['CODEX_REVIEW']],
  ['Adjudication', ['ADJUDICATION']],
  ['Fixes', ['FIXING']],
  ['Codex re-review', ['RE_REVIEW']],
  ['Final acceptance', ['FINAL_ACCEPTANCE']],
  ['Ready to merge', ['READY_TO_MERGE', 'MERGED']],
];

/** Derives everything the UI shows from the event log alone. */
function projectTask(taskId) {
  const events = readEvents(taskId);
  if (!events.length) return null;
  const created = events.find((e) => e.type === 'TASK_CREATED');
  if (!created) return null;

  let state = 'NEW';
  const visited = new Set();
  for (const e of events) {
    if (e.type === 'STATE_TRANSITION') {
      state = e.payload.to;
      visited.add(e.payload.to);
    } else if (e.type === 'ESCALATION') state = 'ESCALATED';
    else if (e.type === 'READY_TO_MERGE') state = 'READY_TO_MERGE';
    else if (e.type === 'MERGED') state = 'MERGED';
    else if (e.type === 'PAUSED_RATE_LIMIT') state = 'PAUSED_RATE_LIMIT';
  }

  const timeline = PHASES.map(([label, states]) => {
    const reached = states.some((s) => visited.has(s));
    const current = states.includes(state);
    return { label, status: current ? 'running' : reached ? 'done' : 'pending' };
  });
  if (['READY_TO_MERGE', 'MERGED'].includes(state)) {
    for (const t of timeline) if (t.status === 'pending') t.status = 'done';
    timeline[timeline.length - 1].status = 'done';
  }
  const doneCount = timeline.filter((t) => t.status === 'done').length;

  const findings = [];
  for (const e of events) {
    if ((e.type === 'FINDING' || e.type === 'DESIGN_REVIEW') && Array.isArray(e.payload.findings)) {
      for (const f of e.payload.findings) findings.push({ ...f, round: e.payload.round ?? null });
    }
  }
  const adjudications = events.filter((e) => e.type === 'ADJUDICATION').map((e) => e.payload);
  for (const f of findings) {
    const a = adjudications.find((x) => x.findingId === f.findingId);
    f.verdict = a ? a.verdict : 'NOT ADJUDICATED';
    f.requiredFix = a?.requiredFix ?? null;
    f.reasoning = a?.reasoning ?? null;
  }

  const tests = events.filter((e) => e.type === 'TEST_RESULT').map((e) => e.payload);
  const verified = [];
  const notVerified = [];
  for (const e of events.filter((x) => x.type === 'RUNTIME_EVIDENCE')) {
    for (const v of e.payload.verified ?? []) if (!verified.includes(v)) verified.push(v);
    for (const v of e.payload.notVerified ?? []) if (!notVerified.includes(v)) notVerified.push(v);
  }
  for (const e of events.filter((x) => x.type === 'DEFERRED')) {
    notVerified.push(`DEFERRED: ${e.payload.what} — ${e.payload.why}`);
  }
  for (const e of events.filter((x) => x.type === 'BACKFILL_GAP')) {
    notVerified.push(`EVIDENCE GAP: ${e.payload.what} — ${e.payload.why}`);
  }

  const impl = events.filter((e) => e.type === 'IMPLEMENTATION' || e.type === 'FIX');
  const commits = impl.map((e) => e.payload.commit).filter(Boolean);
  const filesChanged = [...new Set(impl.flatMap((e) => e.payload.filesChanged ?? []))];
  const escalation = events.filter((e) => e.type === 'ESCALATION').map((e) => e.payload.reason);
  const pauses = events.filter((e) => e.type === 'PAUSED_RATE_LIMIT').map((e) => e.payload);
  const rtm = events.filter((e) => e.type === 'READY_TO_MERGE').map((e) => e.payload)[0] ?? null;

  return {
    taskId,
    title: created.payload.title,
    risk: created.payload.risk,
    branch: created.payload.branch,
    createdAt: created.ts,
    updatedAt: events[events.length - 1].ts,
    state,
    progress: Math.round((doneCount / timeline.length) * 100),
    timeline,
    findings,
    tests,
    verified,
    notVerified,
    commits,
    filesChanged,
    reviewRounds: events.filter((e) => e.type === 'FINDING' && e.payload.roundStart).length,
    escalation,
    pauses,
    readyToMerge: rtm,
    reconstructed: events.some((e) => e.reconstructed),
    simulated: events.some((e) => e.simulated),
    eventCount: events.length,
    log: events.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      type: e.type,
      actor: e.actor,
      reconstructed: !!e.reconstructed,
      simulated: !!e.simulated,
      summary: summarize(e),
    })),
  };
}

function summarize(e) {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'TASK_CREATED': return `${p.title} (risk=${p.risk})`;
    case 'STATE_TRANSITION': return `${p.from} → ${p.to}`;
    case 'DESIGN_DECISION': return p.final ? 'final design' : 'draft design';
    case 'DESIGN_REVIEW': return `verdict=${p.verdict} findings=${(p.findings ?? []).length}`;
    case 'IMPLEMENTATION': return `${p.status} ${p.subject ?? ''}`.trim();
    case 'FINDING': return `round ${p.round ?? '?'}: ${(p.findings ?? []).length} finding(s)`;
    case 'ADJUDICATION': return `${p.findingId} → ${p.verdict}`;
    case 'FIX': return `round ${p.round}: ${p.status}`;
    case 'TEST_RESULT': return `${p.name}: ${p.passed}p/${p.failed}f/${p.skipped}s exit=${p.exitCode}`;
    case 'RUNTIME_EVIDENCE': return `${p.tier} acceptance ok=${p.ok}`;
    case 'VERDICT': return String(p.verdict);
    case 'DEFERRED': return `${p.what}`;
    case 'ESCALATION': return String(p.reason);
    case 'PAUSED_RATE_LIMIT': return `${p.provider} quota reached (no API fallback)`;
    case 'READY_TO_MERGE': return `${p.branch} (auto-merge ${p.autoMerge ? 'on' : 'off'})`;
    case 'MERGE_APPROVED': return `approved by ${p.owner}`;
    case 'MERGED': return String(p.sha ?? '');
    case 'BACKFILL_GAP': return `${p.what}`;
    case 'EVIDENCE_CONFLICT': return String(p.detail);
    case 'POLICY_BLOCK': return `${p.rule}: ${p.detail}`;
    default: return '';
  }
}

/** Observatory metrics, rebuilt from events every request. Never stored. */
function metrics() {
  const ids = taskIds();
  const m = {
    sampleSize: ids.length,
    historicalOnly: ids.every((id) => readEvents(id).some((e) => e.reconstructed)),
    claude: { designs: 0, adjudications: 0, confirmed: 0, partial: 0, rejected: 0 },
    claudeCode: { implementations: 0, fixRounds: 0, scopeExpansions: 0 },
    codex: { findings: 0, blockers: 0, confirmed: 0, partial: 0, rejected: 0, notAdjudicated: 0 },
    system: { escalations: 0, evidenceConflicts: 0, policyBlocks: 0, pauses: 0, gaps: 0, deferred: 0 },
    matrix: { claudeCorrectedClaudeCode: 0, codexCorrectedClaudeCode: 0, runtimeCorrected: 0 },
    disagreements: { claudeRight: 0, codexRight: 0, mixed: 0 },
  };
  for (const id of ids) {
    const ev = readEvents(id);
    for (const e of ev) {
      const p = e.payload ?? {};
      switch (e.type) {
        case 'DESIGN_DECISION': m.claude.designs += 1; break;
        case 'IMPLEMENTATION': m.claudeCode.implementations += 1; break;
        case 'FIX': m.claudeCode.fixRounds += 1; m.claude.adjudications += 0; break;
        case 'FINDING':
        case 'DESIGN_REVIEW':
          for (const f of p.findings ?? []) {
            m.codex.findings += 1;
            if (f.severity === 'BLOCKER') m.codex.blockers += 1;
          }
          break;
        case 'ADJUDICATION':
          m.claude.adjudications += 1;
          if (p.verdict === 'CONFIRMED') { m.claude.confirmed += 1; m.codex.confirmed += 1; m.disagreements.codexRight += 1; m.matrix.codexCorrectedClaudeCode += 1; }
          else if (p.verdict === 'PARTIAL') { m.claude.partial += 1; m.codex.partial += 1; m.disagreements.mixed += 1; }
          else if (p.verdict === 'REJECTED') { m.claude.rejected += 1; m.codex.rejected += 1; m.disagreements.claudeRight += 1; }
          break;
        case 'ESCALATION': m.system.escalations += 1; break;
        case 'EVIDENCE_CONFLICT': m.system.evidenceConflicts += 1; m.matrix.runtimeCorrected += 1; break;
        case 'POLICY_BLOCK': m.system.policyBlocks += 1; break;
        case 'PAUSED_RATE_LIMIT': m.system.pauses += 1; break;
        case 'BACKFILL_GAP': m.system.gaps += 1; break;
        case 'DEFERRED': m.system.deferred += 1; break;
        default: break;
      }
    }
  }
  const adjudicatedIds = new Set();
  for (const id of ids) for (const e of readEvents(id)) if (e.type === 'ADJUDICATION') adjudicatedIds.add(e.payload.findingId);
  m.codex.notAdjudicated = Math.max(0, m.codex.findings - adjudicatedIds.size);
  return m;
}

// ---------------------------------------------------------------------------
// Autopilot invocation — fixed verbs only, never a shell
// ---------------------------------------------------------------------------

const AI_BIN = ['bash', '-lc'];
function runAi(args, cb) {
  // args is a fixed-shape array built here, never from user text except the
  // task title, which is passed as a single argv element (no shell parsing).
  const quoted = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  execFile(AI_BIN[0], [AI_BIN[1], `cd ${REPO} && pnpm ai ${quoted}`], { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, cb);
}

const running = new Map(); // taskId -> child process

function startRun(taskId) {
  if (running.has(taskId)) return false;
  const child = spawn(AI_BIN[0], [AI_BIN[1], `cd ${REPO} && pnpm ai run ${taskId}`], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(taskId, child);
  const logPath = path.join('/srv/ai-accounting/logs', `run-${taskId}.log`);
  const out = fs.createWriteStream(logPath, { flags: 'a' });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on('exit', () => { running.delete(taskId); broadcast(taskId); });
  return true;
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const clients = new Set();
function broadcast(taskId) {
  const payload = JSON.stringify({ taskId, at: new Date().toISOString() });
  for (const res of clients) {
    try { res.write(`event: change\ndata: ${payload}\n\n`); } catch { /* dropped */ }
  }
}
// The event log is the source of truth, so change detection is a cheap poll of
// its size rather than a parallel notification channel that could drift.
let lastSig = '';
setInterval(() => {
  let sig = '';
  for (const id of taskIds()) {
    try { sig += id + fs.statSync(path.join(AI_DIR, 'tasks', id, 'events.jsonl')).size + ';'; } catch { /* gone */ }
  }
  if (sig !== lastSig) { lastSig = sig; broadcast(null); }
}, 2000).unref();

// ---------------------------------------------------------------------------
// System status
// ---------------------------------------------------------------------------

function sh(cmd) {
  return new Promise((resolve) => {
    execFile('bash', ['-lc', cmd], { timeout: 15000 }, (err, stdout) => resolve((stdout ?? '').trim()));
  });
}

async function systemStatus() {
  const [claudeAuth, codexAuth, docker, disk, svc] = await Promise.all([
    sh('claude auth status 2>/dev/null || echo "{}"'),
    sh('codex login status 2>&1 | head -2 || true'),
    sh('docker ps --format "{{.Names}}" 2>/dev/null | wc -l'),
    sh("df -h / | tail -1 | awk '{print $4\" free of \"$2}'"),
    sh('systemctl is-active ai-control-center 2>/dev/null; systemctl is-active ai-autopilot 2>/dev/null'),
  ]);
  let claude = 'unknown';
  try {
    const j = JSON.parse(claudeAuth);
    claude = j.loggedIn ? `authenticated (${j.authMethod})` : 'not authenticated';
  } catch { claude = 'unavailable'; }
  const codex = /not logged in/i.test(codexAuth) ? 'not authenticated'
    : /logged in|chatgpt|account/i.test(codexAuth) ? 'authenticated' : 'unknown';

  const mariadb = await sh('docker inspect -f "{{.State.Status}}" ai-accounting-mariadb-1 2>/dev/null || echo missing');
  const redis = await sh('docker inspect -f "{{.State.Status}}" ai-accounting-redis-1 2>/dev/null || echo missing');
  const accounting = await sh(`curl -s -o /dev/null -w "%{http_code}" --max-time 8 ${ACCOUNTING_URL}/ 2>/dev/null || echo 000`);

  return {
    environment: ENVIRONMENT,
    accountingUrl: ACCOUNTING_URL,
    accountingHttp: accounting,
    claude,
    codex,
    billingMode: 'SUBSCRIPTION_CLI_ONLY',
    paidApiKeys: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => (process.env[k] ?? '').length > 0),
    dockerContainers: Number(docker || 0),
    testMariadb: mariadb,
    testRedis: redis,
    disk,
    memory: `${Math.round(os.freemem() / 2 ** 30)}G free of ${Math.round(os.totalmem() / 2 ** 30)}G`,
    load: os.loadavg().map((n) => n.toFixed(2)).join(' '),
    uptimeHours: Math.round(os.uptime() / 3600),
    services: svc.split('\n').filter(Boolean),
    runningTasks: [...running.keys()],
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 256 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid json')); }
    });
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    // One bad request must not kill the control plane. Before this guard a
    // failed write inside the handler crashed the process, and the proxy
    // reported the dead upstream as a 502 - hiding the real error.
    process.stderr.write(`request failed: ${req.method} ${req.url}: ${err?.stack ?? err}\n`);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else try { res.end(); } catch { /* already gone */ }
  });
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`uncaughtException: ${err?.stack ?? err}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`unhandledRejection: ${err?.stack ?? err}\n`);
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';

  // No inline script/style beyond our own; nothing external is ever loaded.
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

  if (p === '/healthz') return json(res, 200, { ok: true });

  if (p === '/' || p === '/index.html') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    });
    return res.end(HTML);
  }

  const owner = readOwner();

  if (p === '/api/session' && req.method === 'GET') {
    const s = sessionFrom(req);
    return json(res, 200, {
      authenticated: !!s,
      setupRequired: !owner,
      csrf: s?.csrf ?? null,
      user: s?.user ?? null,
      publicUrl: PUBLIC_URL,
      environment: ENVIRONMENT,
    });
  }

  // One-time browser bootstrap. Permanently disabled once an owner exists.
  if (p === '/api/setup' && req.method === 'POST') {
    if (owner) return json(res, 409, { error: 'setup already completed' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const { username, password, token } = body;
    const tokenFile = path.join(CONF_DIR, 'setup-token');
    if (!fs.existsSync(tokenFile)) return json(res, 409, { error: 'no setup token present' });
    const expected = fs.readFileSync(tokenFile, 'utf8').trim();
    const given = String(token ?? '');
    if (given.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      return json(res, 403, { error: 'invalid setup token' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return json(res, 400, { error: 'password must be at least 12 characters' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    try {
      fs.writeFileSync(OWNER_FILE, JSON.stringify({
        username: String(username || 'owner'), salt, hash: hashPassword(password, salt),
        createdAt: new Date().toISOString(),
      }), { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`owner write failed: ${err?.message}\n`);
      return json(res, 500, { error: 'could not persist the owner account', detail: String(err?.code ?? '') });
    }
    // The bootstrap path is destroyed, not merely hidden: a consumed token can
    // never be replayed, even by someone who saw it.
    try { fs.rmSync(tokenFile, { force: true }); } catch { /* best effort */ }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (!owner) return json(res, 409, { error: 'setup required' });
    if (throttled(ip)) return json(res, 429, { error: 'too many attempts; wait 15 minutes' });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const ok = String(body.username ?? '') === owner.username && verifyPassword(String(body.password ?? ''), owner);
    noteAttempt(ip, ok);
    if (!ok) return json(res, 401, { error: 'invalid credentials' });
    const s = newSession(owner.username);
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': `${COOKIE}=${s.id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    });
    return res.end(JSON.stringify({ ok: true, csrf: s.csrf }));
  }

  // Everything below requires a session.
  const sess = sessionFrom(req);
  if (!p.startsWith('/api/')) return json(res, 404, { error: 'not found' });
  if (!sess) return json(res, 401, { error: 'authentication required' });

  if (req.method === 'POST') {
    if (p !== '/api/logout' && req.headers['x-csrf-token'] !== sess.csrf) {
      return json(res, 403, { error: 'csrf token mismatch' });
    }
  }

  if (p === '/api/logout' && req.method === 'POST') {
    sessions.delete(sess.id);
    saveSessions();
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0` });
    return res.end('{"ok":true}');
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    return json(res, 200, { tasks: taskIds().map(projectTask).filter(Boolean).reverse() });
  }

  if (p === '/api/tasks' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const title = String(body.title ?? '').trim().slice(0, 500);
    const risk = ['low', 'medium', 'high'].includes(body.risk) ? body.risk : 'high';
    if (!title) return json(res, 400, { error: 'a description is required' });
    return runAi(['task', 'create', '--risk', risk, title], (err, stdout, stderr) => {
      if (err) return json(res, 500, { error: 'task creation failed', detail: String(stderr || err.message).slice(0, 2000) });
      const m = /(TASK-\d+)/.exec(stdout ?? '');
      const taskId = m ? m[1] : null;
      if (taskId && body.autostart !== false) startRun(taskId);
      broadcast(taskId);
      return json(res, 200, { ok: true, taskId, output: String(stdout).slice(0, 2000) });
    });
  }

  const detail = /^\/api\/tasks\/(TASK-\d+)(?:\/(\w[\w-]*))?$/.exec(p);
  if (detail) {
    const [, taskId, action] = detail;
    if (req.method === 'GET' && !action) {
      const t = projectTask(taskId);
      return t ? json(res, 200, t) : json(res, 404, { error: 'unknown task' });
    }
    if (req.method === 'POST') {
      if (action === 'resume') {
        const started = startRun(taskId);
        return json(res, 200, { ok: true, started });
      }
      if (action === 'pause' || action === 'cancel') {
        const child = running.get(taskId);
        if (child) { child.kill('SIGTERM'); running.delete(taskId); }
        // State stays exactly as the log last recorded it, so a resume picks up
        // from a real persisted state rather than a guess.
        return json(res, 200, { ok: true, stopped: !!child });
      }
      if (action === 'approve-merge') {
        const t = projectTask(taskId);
        if (!t) return json(res, 404, { error: 'unknown task' });
        // The authenticated session user is what gets written into the
        // immutable approval record - not anything the client sends.
        return runAi(['merge', 'approve', taskId, '--owner', sess.user], (err, stdout, stderr) => {
          broadcast(taskId);
          const out = String(stdout ?? '') + String(stderr ?? '');
          const m = /RESULT:(\{.*\})/.exec(out);
          let parsed = null;
          try { parsed = m ? JSON.parse(m[1]) : null; } catch { parsed = null; }
          if (parsed && parsed.ok) return json(res, 200, parsed);
          return json(res, 409, parsed ?? { error: 'merge refused', detail: out.slice(-1500) });
        });
      }
      if (action === 'deploy') {
        const t = projectTask(taskId);
        if (!t) return json(res, 404, { error: 'unknown task' });
        if (t.state !== 'MERGED') return json(res, 409, { error: `task is ${t.state}, not MERGED` });
        return json(res, 501, {
          error: 'production deployment from the browser is not enabled yet',
          detail: 'DEPLOYMENT_APPROVED/DEPLOYED are modelled; the production stack is still being brought up.',
        });
      }
    }
  }

  const pre = /^\/api\/tasks\/(TASK-\d+)\/merge-preflight$/.exec(p);
  if (pre && req.method === 'GET') {
    return runAi(['merge', 'preflight', pre[1]], (err, stdout) => {
      const m = /RESULT:(\{[\s\S]*\})/.exec(String(stdout ?? ''));
      try { return json(res, 200, m ? JSON.parse(m[1]) : { ok: false, problems: ['preflight produced no result'] }); }
      catch { return json(res, 200, { ok: false, problems: ['preflight output could not be parsed'] }); }
    });
  }

  if (p === '/api/metrics' && req.method === 'GET') return json(res, 200, metrics());
  if (p === '/api/system/status' && req.method === 'GET') return json(res, 200, await systemStatus());

  if (p === '/api/events/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* gone */ } }, 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return undefined;
  }

  return json(res, 404, { error: 'not found' });
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`ai-control-center listening on ${HOST}:${PORT} (public ${PUBLIC_URL})\n`);
});
