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
  let s = sessions.get(m[1]);
  if (!s) {
    // Miss: re-read the session file before rejecting. The file is the durable
    // record and the in-memory map is a cache of it, so a session minted
    // out-of-process (the operator's `cc-session mint`, used to exercise the
    // API without ever handling the owner's password) is honoured.
    //
    // This grants nothing new: the file is 0600 under a root-owned config tree,
    // so anyone able to write it already controls the host.
    loadSessions();
    s = sessions.get(m[1]);
  }
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

// Only real tasks. The deployment audit log lives under the same tasks/ tree so
// it inherits the same append-only guarantees, but it is not a task and must
// never inflate the task list or the Observatory's sample size.
const TASK_ID = /^TASK-\d+$/;
const DEPLOY_LOG_ID = 'DEPLOY-PRODUCTION';

function logIds() {
  const dir = path.join(AI_DIR, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl'))).sort();
}

function taskIds() {
  return logIds().filter((d) => TASK_ID.test(d));
}

/** Display-only repair of literal \n stored by the old pnpm-quoted path. */
function unescapeStoredNewlines(text) {
  return typeof text === 'string' && !text.includes('\n') && /\\n/.test(text)
    ? text.replace(/\\r\\n|\\n/g, '\n')
    : text;
}

/** First non-empty line, for a scannable list label. */
function displayTitle(text) {
  const t = unescapeStoredNewlines(String(text ?? ''));
  const first = t.split('\n').map((l) => l.trim()).find((l) => l.length) ?? t;
  return first.length > 120 ? first.slice(0, 119) + '\u2026' : first;
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

/**
 * Workflow phases, each with the evidence that proves it actually completed.
 *
 * Entering a state is not the same as finishing the phase. TASK-0007 escalated
 * because Claude's design could not be used, yet the UI showed "Claude design:
 * done" purely because the task had reached DESIGNING — which is exactly the
 * kind of reassuring-but-false projection this whole system exists to avoid. A
 * phase is `done` only when the event that constitutes its output is present.
 */
const PHASES = [
  ['Claude design', ['DESIGNING'], (ev) => ev.some((e) => e.type === 'DESIGN_DECISION')],
  ['Codex design review', ['DESIGN_REVIEW'], (ev) => ev.some((e) => e.type === 'DESIGN_REVIEW')],
  ['Claude adjudication', ['DESIGN_ADJUDICATION'],
    (ev) => ev.some((e) => e.type === 'DESIGN_DECISION' && e.payload?.final === true)],
  ['Claude Code implementation', ['IMPLEMENTING'], (ev) => ev.some((e) => e.type === 'IMPLEMENTATION')],
  ['Tests', ['TESTING'], (ev) => ev.some((e) => e.type === 'TEST_RESULT')],
  ['Pre-review acceptance', ['PRE_REVIEW_ACCEPTANCE'],
    (ev) => ev.some((e) => e.type === 'RUNTIME_EVIDENCE' && e.payload?.tier === 'pre-review')],
  ['Codex implementation review', ['CODEX_REVIEW'], (ev) => ev.some((e) => e.type === 'FINDING')],
  ['Adjudication', ['ADJUDICATION'], (ev) => ev.some((e) => e.type === 'ADJUDICATION')],
  ['Fixes', ['FIXING'], (ev) => ev.some((e) => e.type === 'FIX')],
  ['Codex re-review', ['RE_REVIEW'],
    (ev) => ev.some((e) => e.type === 'FINDING' && Number(e.payload?.round ?? 1) > 1)],
  ['Final acceptance', ['FINAL_ACCEPTANCE'],
    (ev) => ev.some((e) => e.type === 'RUNTIME_EVIDENCE' && e.payload?.tier === 'final' && e.payload?.ok === true)],
  ['Ready to merge', ['READY_TO_MERGE'], (ev) => ev.some((e) => e.type === 'READY_TO_MERGE')],
  ['Merged', ['MERGED'], (ev) => ev.some((e) => e.type === 'MERGED')],
  ['Deployed to production', ['DEPLOYED'], (ev) => ev.some((e) => e.type === 'DEPLOYED')],
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
    else if (e.type === 'MERGED') { state = 'MERGED'; visited.add('MERGED'); }
    else if (e.type === 'DEPLOYED') { state = 'DEPLOYED'; visited.add('DEPLOYED'); }
    else if (e.type === 'PAUSED_RATE_LIMIT') state = 'PAUSED_RATE_LIMIT';
  }

  // The state the task was in when it escalated: that phase failed, it did not
  // complete, and it is not "running" either.
  let escalatedFrom = null;
  if (state === 'ESCALATED') {
    let last = 'NEW';
    for (const e of events) {
      if (e.type === 'STATE_TRANSITION') last = e.payload.to;
      else if (e.type === 'ESCALATION') { escalatedFrom = last; break; }
    }
  }

  const timeline = PHASES.map(([label, states, hasEvidence]) => {
    const done = hasEvidence(events);
    const failedHere = escalatedFrom !== null && states.includes(escalatedFrom) && !done;
    const current = state !== 'ESCALATED' && states.includes(state) && !done;
    return {
      label,
      status: done ? 'done' : failedHere ? 'failed' : current ? 'running' : 'pending',
    };
  });
  // Reaching a terminal state means every phase before it completed, even if a
  // resumed run never emitted an explicit transition for one of them. Merge and
  // deploy are separate approvals, so they are NOT back-filled: a merged task
  // must still show "Deployed to production" as pending until it really is.
  // No back-filling. Reaching a terminal state used to mark every earlier phase
  // done regardless of whether it happened, which both hid failures and claimed
  // phases that never ran — a task needing no fixes would still report "Fixes:
  // done". A phase with no evidence stays pending, which is what is true.
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
  const mergeApproved = events.filter((e) => e.type === 'MERGE_APPROVED').map((e) => e.payload).pop() ?? null;
  const merged = events.filter((e) => e.type === 'MERGED').map((e) => e.payload).pop() ?? null;
  const deployApproved = events.filter((e) => e.type === 'DEPLOYMENT_APPROVED').map((e) => e.payload).pop() ?? null;
  const deployed = events.filter((e) => e.type === 'DEPLOYED').map((e) => e.payload).pop() ?? null;
  const deployFailed = events.filter((e) => e.type === 'DEPLOYMENT_FAILED').map((e) => e.payload);

  // Provenance is stated per task rather than inferred site-wide: a live task
  // and a reconstructed one must never be averaged into one number.
  const provenance = events.some((e) => e.simulated) ? 'SIMULATED'
    : events.some((e) => e.reconstructed) ? 'HISTORICAL / RECONSTRUCTED'
    : 'LIVE';

  const designRetries = events.filter((e) => e.type === 'DESIGN_RETRY').map((e) => e.payload);

  return {
    taskId,
    provenance,
    // Tasks created before the pnpm-escaping fix stored literal "\n" inside the
    // title. The immutable log is never rewritten, so the two-character sequence
    // is turned back into a line break for display only.
    description: unescapeStoredNewlines(created.payload.description ?? created.payload.title),
    designRetries,
    mergeApproved,
    merged,
    deployApproved,
    deployed,
    deployFailed,
    title: displayTitle(created.payload.title),
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
    case 'MERGE_APPROVED': return `approved by ${p.authenticatedOwner ?? p.owner ?? 'unknown'}`;
    case 'MERGED': return String(p.mergeSha ?? p.mainSha ?? p.sha ?? '').slice(0, 9);
    case 'DEPLOYMENT_APPROVED':
      return `${String(p.targetSha ?? '').slice(0, 9)} approved by ${p.authenticatedOwner ?? 'unknown'}`;
    case 'DEPLOYED':
      return `${String(p.deployedSha ?? '').slice(0, 9)} (was ${String(p.previousProductionSha ?? 'none').slice(0, 9)})`;
    case 'DEPLOYMENT_FAILED':
      return `${String(p.attemptedSha ?? '').slice(0, 9)}: ${p.detail ?? 'failed'}`;
    case 'BACKFILL_GAP': return `${p.what}`;
    case 'EVIDENCE_CONFLICT': return String(p.detail);
    case 'POLICY_BLOCK': return `${p.rule}: ${p.detail}`;
    default: return '';
  }
}

/** Observatory metrics, rebuilt from events every request. Never stored. */
function metrics() {
  const ids = taskIds();
  // Per-task provenance, stated rather than averaged. A reconstructed Stage 0
  // and a live task are both real evidence but they are not the same kind of
  // evidence, and collapsing them into one percentage would invent precision.
  const tasks = ids.map((id) => {
    const ev = readEvents(id);
    const created = ev.find((e) => e.type === 'TASK_CREATED');
    return {
      taskId: id,
      title: created?.payload?.title ?? id,
      provenance: ev.some((e) => e.simulated) ? 'SIMULATED'
        : ev.some((e) => e.reconstructed) ? 'HISTORICAL / RECONSTRUCTED'
        : 'LIVE',
      events: ev.length,
      findings: ev.filter((e) => e.type === 'FINDING' || e.type === 'DESIGN_REVIEW')
        .reduce((n, e) => n + (e.payload.findings ?? []).length, 0),
      adjudications: ev.filter((e) => e.type === 'ADJUDICATION').length,
    };
  });
  const m = {
    sampleSize: ids.length,
    liveSampleSize: tasks.filter((t) => t.provenance === 'LIVE').length,
    reconstructedSampleSize: tasks.filter((t) => t.provenance === 'HISTORICAL / RECONSTRUCTED').length,
    simulatedSampleSize: tasks.filter((t) => t.provenance === 'SIMULATED').length,
    tasks,
    historicalOnly: ids.length > 0 && ids.every((id) => readEvents(id).some((e) => e.reconstructed)),
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

/**
 * Invokes the Autopilot CLI directly — no shell, no `pnpm`.
 *
 * There were two reasons to stop going through `bash -lc "pnpm ai …"`:
 *
 *  1. `pnpm` escapes newlines in appended script arguments into the literal
 *     two-character sequence `\n`. A multi-line task description typed in the
 *     browser was stored with `\n` showing as text. Invoking ts-node directly
 *     preserves it exactly; verified both ways before changing this.
 *  2. It removes shell quoting from the path that carries user- and
 *     agent-influenced text. argv goes straight to execFile, so there is no
 *     metacharacter surface to get wrong.
 */
const TS_NODE = process.env.AI_TS_NODE ??
  path.join(REPO, 'packages/server/node_modules/.bin/ts-node');
const CLI_ENTRY = path.join(REPO, 'tools/autopilot/cli.ts');
const CLI_TSCONFIG = path.join(REPO, 'tools/autopilot/tsconfig.json');

function aiArgv(args) {
  return [TS_NODE, '--transpile-only', '-P', CLI_TSCONFIG, CLI_ENTRY, ...args.map(String)];
}

function runAi(args, cb, timeout = 120000) {
  const argv = aiArgv(args);
  execFile(argv[0], argv.slice(1), {
    cwd: REPO,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  }, cb);
}

/** Pulls the single RESULT: line the CLI verbs print. */
function parseResult(stdout, stderr) {
  const out = String(stdout ?? '') + String(stderr ?? '');
  const m = /RESULT:(\{[\s\S]*?\})\s*$/m.exec(out);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Durable production release state, written by deploy-production. */
function releaseState() {
  const p = process.env.AI_RELEASE_FILE ?? '/srv/ai-accounting/state/release.env';
  const out = { currentSha: null, previousSha: null, deployedAt: null, result: null, detail: null };
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = /^([a-zA-Z]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2] || null;
    }
  } catch { /* nothing deployed yet */ }
  return out;
}

/** The deployment audit stream, projected for display. Never a second store. */
function deploymentAudit(limit = 40) {
  const seen = [];
  for (const id of logIds()) {
    for (const e of readEvents(id)) {
      if (!['DEPLOYMENT_APPROVED', 'DEPLOYED', 'DEPLOYMENT_FAILED'].includes(e.type)) continue;
      seen.push({
        logId: id,
        taskId: e.payload.taskId ?? null,
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        owner: e.payload.authenticatedOwner ?? e.payload.approvedBy ?? null,
        sha: e.payload.deployedSha ?? e.payload.targetSha ?? e.payload.attemptedSha ?? null,
        previousSha: e.payload.previousProductionSha ?? null,
        detail: e.payload.detail ?? null,
        health: e.payload.healthResult ?? null,
        backup: e.payload.backupState ?? null,
        migrationsReversed: e.payload.migrationsReversed ?? null,
      });
    }
  }
  seen.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return seen.slice(0, limit);
}

const running = new Map(); // taskId -> child process

// A deployment rebuilds images and restarts the production stack. Two at once
// would race over the same containers, so it is serialised here as well as by
// the lock file deploy-production takes.
let deploying = false;
const DEPLOY_TIMEOUT_MS = 45 * 60 * 1000;

function startRun(taskId) {
  if (running.has(taskId)) return false;
  const argv = aiArgv(['run', taskId]);
  const child = spawn(argv[0], argv.slice(1), {
    cwd: REPO,
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

// A short replay buffer so a reconnecting browser can ask for what it missed
// via Last-Event-ID instead of silently skipping a transition. Bounded: this is
// a recovery window, not a second event store.
let sseSeq = 0;
const REPLAY_MAX = 200;
const replay = [];

function broadcast(taskId) {
  sseSeq += 1;
  const id = sseSeq;
  const payload = JSON.stringify({ taskId, at: new Date().toISOString(), id });
  replay.push({ id, payload });
  if (replay.length > REPLAY_MAX) replay.shift();
  const frame = `id: ${id}\nevent: change\ndata: ${payload}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { /* dropped */ }
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

  // Production is reported from the stack itself, never from "Traefik said
  // 200" — a 200 on / is nginx serving the SPA and proves nothing about the
  // database, the queue or object storage behind it.
  const prodNames = ['mysql', 'redis', 'minio', 'gotenberg', 'server', 'webapp', 'envoy'];
  const production = {};
  await Promise.all(prodNames.map(async (n) => {
    production[n] = await sh(
      `docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' bigcapital-prod-${n} 2>/dev/null || echo missing`,
    );
  }));
  const backupPath = await sh('readlink -f /srv/ai-accounting/backups/production/latest 2>/dev/null || true');
  const backupAt = backupPath
    ? await sh(`stat -c %y "${backupPath}/mariadb-all.sql.gz" 2>/dev/null | cut -d. -f1 || true`)
    : '';
  const backupTimer = await sh('systemctl list-timers ai-accounting-backup.timer --no-pager 2>/dev/null | sed -n 2p | tr -s " " | cut -d" " -f1-3');

  return {
    release: releaseState(),
    production,
    productionBackup: { path: backupPath || null, at: backupAt || null, nextRun: backupTimer || null },
    deploying,
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
    // The composer sends one free-text brief. It is stored whole as the
    // description; the title is derived from it by the CLI.
    const description = String(body.title ?? body.description ?? '').trim().slice(0, 8000);
    const risk = ['low', 'medium', 'high'].includes(body.risk) ? body.risk : 'high';
    if (!description) return json(res, 400, { error: 'a description is required' });
    return runAi(['task', 'create', '--risk', risk, '--description', description], (err, stdout, stderr) => {
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
        // Merge and deploy are two separate owner approvals. A task that has
        // just merged does not ship itself, whatever its risk.
        if (t.state !== 'MERGED') return json(res, 409, { error: `task is ${t.state}, not MERGED` });
        if (deploying) return json(res, 409, { error: 'a deployment is already in progress' });
        deploying = true;
        return runAi(['deploy', 'approve', taskId, '--owner', sess.user], (err, stdout, stderr) => {
          deploying = false;
          broadcast(taskId);
          const parsed = parseResult(stdout, stderr);
          if (parsed && parsed.ok) return json(res, 200, parsed);
          return json(res, 409, parsed ?? {
            error: 'deployment refused',
            detail: (String(stdout ?? '') + String(stderr ?? '')).slice(-1500),
          });
        }, DEPLOY_TIMEOUT_MS);
      }
    }
  }

  const pre = /^\/api\/tasks\/(TASK-\d+)\/merge-preflight$/.exec(p);
  if (pre && req.method === 'GET') {
    return runAi(['merge', 'preflight', pre[1]], (err, stdout, stderr) => {
      const parsed = parseResult(stdout, stderr);
      return json(res, 200, parsed ?? { ok: false, problems: ['preflight produced no parseable result'] });
    });
  }

  const dpre = /^\/api\/tasks\/(TASK-\d+)\/deploy-preflight$/.exec(p);
  if (dpre && req.method === 'GET') {
    return runAi(['deploy', 'preflight', dpre[1]], (err, stdout, stderr) => {
      const parsed = parseResult(stdout, stderr);
      return json(res, 200, parsed ?? { ok: false, problems: ['deploy preflight produced no parseable result'] });
    }, 180000);
  }

  // Deploying current approved origin/main with no task attached — how the
  // first release ships, and how a release is re-applied after an incident.
  if (p === '/api/deploy/preflight' && req.method === 'GET') {
    return runAi(['deploy', 'preflight'], (err, stdout, stderr) => {
      const parsed = parseResult(stdout, stderr);
      return json(res, 200, parsed ?? { ok: false, problems: ['deploy preflight produced no parseable result'] });
    }, 180000);
  }

  if (p === '/api/deploy' && req.method === 'POST') {
    if (deploying) return json(res, 409, { error: 'a deployment is already in progress' });
    deploying = true;
    return runAi(['deploy', 'approve', '--owner', sess.user], (err, stdout, stderr) => {
      deploying = false;
      broadcast(null);
      const parsed = parseResult(stdout, stderr);
      if (parsed && parsed.ok) return json(res, 200, parsed);
      return json(res, 409, parsed ?? {
        error: 'deployment refused',
        detail: (String(stdout ?? '') + String(stderr ?? '')).slice(-1500),
      });
    }, DEPLOY_TIMEOUT_MS);
  }

  if (p === '/api/deploy/audit' && req.method === 'GET') {
    return json(res, 200, { release: releaseState(), events: deploymentAudit() });
  }

  if (p === '/api/metrics' && req.method === 'GET') return json(res, 200, metrics());
  if (p === '/api/system/status' && req.method === 'GET') return json(res, 200, await systemStatus());

  if (p === '/api/events/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ lastEventId: sseSeq })}\n\n`);
    // Replay anything the client missed while disconnected. `Last-Event-ID` is
    // the standard header; the query parameter is for clients (and tests) that
    // cannot set headers on an EventSource.
    const lastRaw = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
    const last = Number.parseInt(String(lastRaw ?? ''), 10);
    if (Number.isFinite(last)) {
      for (const r of replay) {
        if (r.id > last) res.write(`id: ${r.id}\nevent: change\ndata: ${r.payload}\n\n`);
      }
    }
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
