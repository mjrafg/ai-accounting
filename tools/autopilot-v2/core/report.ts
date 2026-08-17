/**
 * Persian reporting — observational side-channel over the immutable evidence.
 *
 * Pipeline (smallest robust shape, no agent debates):
 *   1. canonical deterministic SNAPSHOT from real V2 sources (never LLM memory)
 *   2. one language-generation step (Claude Fable 5, subscription CLI)
 *   3. one optional simplification step over the SAME snapshot
 *
 * The narrative can never outrank the snapshot: state, counts, SHAs, VERIFIED /
 * NOT VERIFIED and the owner-action status are computed here and carried as
 * structured fields the UI renders directly; the prose only explains them.
 * If generation fails, a deterministic Persian template renders from the same
 * snapshot — the reporting system never makes a task unusable, and never
 * touches a paid API.
 *
 * Defense in depth: sanitized snapshot in → generation → redaction again on the
 * way out. Report generation must not block or mutate task execution: builders
 * only READ events/streams/git.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { EventStore, deriveTask, currentDesign, allFindings, STATE_ROOT } from './store';
import { redact, redactPayload } from './redact';
import { subscriptionEnv, CLAUDE_MODEL } from './agents';
import { inspectEnvelope } from './parsers';
import { TaskState } from './types';

const CLAUDE_BIN = process.env.AI_CLAUDE_BIN ?? '/home/aiaccounting/.local/bin/claude';
const v1StateRoot = () => process.env.AI_V1_STATE ?? '/srv/ai-accounting/state/ai';

export type DetailLevel = 'NORMAL' | 'SIMPLE';

export interface ReportIdentity {
  taskId: string;
  lastEventId: number;   // cursor: seq of the last event this report covers
  taskHEAD: string;
  generatedAt: string;
  reportType: 'CURRENT' | 'FINAL';
  language: 'fa';
  detailLevel: DetailLevel;
  legacy?: boolean;
}

export interface StatusCard {
  icon: '✅' | '⏳' | '⚠️' | '❌' | '🛈';
  title: string;        // Persian
  detail: string;       // Persian
  actionRequired: boolean;
  actionExplanation?: string; // Persian, only when action required
}

export interface ReportRecord {
  identity: ReportIdentity;
  statusCard: StatusCard;
  narrative: string;     // Persian, RTL; technical tokens in `backticks`
  generator: 'claude-fable-5' | 'deterministic-fallback' | string;
  generationMs: number;
  snapshotMs: number;
  requestedModel?: string;
  effectiveModel?: string;
}

const FINAL_STATES: TaskState[] = [
  'READY_TO_MERGE', 'MERGED', 'READY_TO_DEPLOY', 'DEPLOYED', 'FAILED', 'ESCALATED', 'CANCELLED',
];

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function buildSnapshot(events: EventStore, taskId: string): { snapshot: any; ms: number } {
  const t0 = Date.now();
  const legacy = !/^TASK-V2-\d+$/.test(taskId);
  return { snapshot: legacy ? buildLegacySnapshot(taskId) : buildV2Snapshot(events, taskId), ms: Date.now() - t0 };
}

function buildV2Snapshot(events: EventStore, taskId: string): any {
  const evs = events.read(taskId);
  if (!evs.length) return null;
  const rec = deriveTask(events, taskId)!;
  const design = currentDesign(events, taskId);
  const findings = allFindings(events, taskId);
  const latestCheck = new Map<string, any>();
  for (const e of evs) if (e.type === 'DETERMINISTIC_CHECK') {
    latestCheck.set(`${e.phase ?? ''}:${(e.payload as any).name}`, { ...(e.payload as any), phase: e.phase, ts: e.ts });
  }
  const agents = evs.filter((e) => ['AGENT_STARTED', 'AGENT_FINISHED', 'AGENT_FAILED'].includes(e.type))
    .map((e) => ({ type: e.type, agent: e.agent, phase: e.phase, ts: e.ts, ...(e.payload as any) }));
  const codeChanges = evs.filter((e) => e.type === 'CODE_CHANGE').map((e) => e.payload as any);
  const verified: string[] = []; const notVerified: string[] = [];
  for (const e of evs) if (e.type === 'EVIDENCE') {
    for (const v of (e.payload as any).verified ?? []) verified.push(String(v));
    for (const v of (e.payload as any).notVerified ?? []) notVerified.push(String(v));
  }
  const system = evs.filter((e) => ['POLICY_BLOCK', 'HUMAN_DECISION', 'SETTING_CHANGED',
    'AUTOMATIC_DEPLOYMENT_HELD', 'TASK_CANCELLED', 'NOTE'].includes(e.type))
    .map((e) => ({ type: e.type, ts: e.ts, ...(e.payload as any) }));
  const retries = evs.filter((e) => e.type === 'NOTE' && (e.payload as any).retry).length +
    agents.filter((a) => (a.attempt ?? 1) > 1).length;

  return {
    legacy: false,
    task: { taskId, title: rec.title, description: rec.description, risk: rec.risk,
      createdAt: rec.createdAt, elapsedMs: Date.now() - Date.parse(rec.createdAt) },
    cursor: evs[evs.length - 1].seq,
    state: rec.state, phase: rec.phase, subPhase: rec.subPhase,
    baseSha: rec.baseSha, headSha: rec.headSha, branch: rec.branch,
    awaitingHuman: rec.awaitingHuman ?? null,
    lastError: rec.lastError ?? null,
    timeline: evs.filter((e) => e.type === 'STATE_CHANGED')
      .map((e) => ({ ts: e.ts, from: (e.payload as any).from, to: (e.payload as any).to, subPhase: e.subPhase })),
    agents,
    design: design ? { revision: design.revision, plan: design.plan, scopeAllowlist: design.scopeAllowlist,
      invariants: design.invariants, requiredTests: design.requiredTests } : null,
    designRevisions: evs.filter((e) => e.type === 'DESIGN_REVISION').length,
    findings,
    changes: codeChanges,
    tests: evs.filter((e) => e.type === 'TEST_RESULT').map((e) => ({ ...(e.payload as any), ts: e.ts })),
    deterministicEvidence: [...latestCheck.values()],
    systemEvents: system,
    retries,
    merge: evs.filter((e) => e.type === 'MERGE_RESULT').map((e) => e.payload as any).pop() ?? null,
    deployment: evs.filter((e) => e.type === 'DEPLOY_RESULT').map((e) => e.payload as any).pop() ?? null,
    deploymentHeld: evs.some((e) => e.type === 'AUTOMATIC_DEPLOYMENT_HELD'),
    verified: [...new Set(verified)],
    notVerified: [...new Set(notVerified)],
    pending: pendingFor(rec.state, rec.subPhase),
  };
}

/** V1 legacy: reconstructed from the historical V1 event log, clearly labeled. */
function buildLegacySnapshot(taskId: string): any {
  const p = path.join(v1StateRoot(), 'tasks', taskId, 'events.jsonl');
  if (!fs.existsSync(p)) return null;
  const evs: any[] = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!evs.length) return null;
  const created = evs.find((e) => e.type === 'TASK_CREATED');
  let state = 'UNKNOWN';
  for (const e of evs) {
    if (e.type === 'STATE_TRANSITION') state = e.payload?.to ?? state;
    if (e.type === 'READY_TO_MERGE') state = 'READY_TO_MERGE';
    if (e.type === 'ESCALATION') state = 'ESCALATED';
    if (e.type === 'TASK_CANCELLED') state = 'CANCELLED';
  }
  const findings: any[] = [];
  for (const e of evs) if (e.type === 'FINDING' || e.type === 'DESIGN_REVIEW') {
    for (const f of e.payload?.findings ?? []) findings.push(f);
  }
  return {
    legacy: true,
    task: { taskId, title: String(created?.payload?.title ?? taskId).replace(/\\n/g, ' ').slice(0, 200),
      description: String(created?.payload?.description ?? created?.payload?.title ?? ''), risk: created?.payload?.risk ?? 'unknown',
      createdAt: created?.ts ?? '', elapsedMs: 0 },
    cursor: evs.length,
    state, phase: '', subPhase: '',
    baseSha: String(created?.payload?.baseRef ?? ''), headSha: '', branch: String(created?.payload?.branch ?? ''),
    awaitingHuman: null, lastError: null,
    timeline: evs.filter((e) => e.type === 'STATE_TRANSITION').map((e) => ({ ts: e.ts, from: e.payload?.from, to: e.payload?.to })),
    agents: [], design: null, designRevisions: evs.filter((e) => e.type === 'DESIGN_DECISION').length,
    findings, changes: [],
    tests: evs.filter((e) => e.type === 'TEST_RESULT').map((e) => e.payload),
    deterministicEvidence: [], systemEvents: [], retries: evs.filter((e) => e.type === 'DESIGN_RETRY').length,
    merge: null, deployment: null, deploymentHeld: false,
    verified: [], notVerified: ['گزارش از شواهد تاریخی V1 بازسازی شده است؛ V1 برخی جزئیات (مانند مدل مؤثر و رویدادهای سیستم) را ثبت نمی‌کرد.'],
    pending: [],
  };
}

function pendingFor(state: TaskState, subPhase: string): string[] {
  switch (state) {
    case 'NEW': return ['شروع طراحی'];
    case 'DESIGN': return ['تکمیل طراحی', 'پیاده‌سازی', 'تست‌ها', 'بررسی مستقل', 'پذیرش نهایی'];
    case 'IMPLEMENT': return ['تکمیل پیاده‌سازی', 'تست‌ها', 'بررسی مستقل', 'پذیرش نهایی'];
    case 'VERIFY': return ['تکمیل تست‌های سریع', 'بررسی مستقل', 'پذیرش نهایی'];
    case 'REVIEW': return ['تکمیل بررسی مستقل', 'پذیرش نهایی'];
    case 'FIX': return ['اعمال اصلاح', 'تست مجدد', 'پذیرش نهایی'];
    case 'FINAL_ACCEPTANCE': return ['تکمیل پذیرش نهایی', 'تصمیم Merge'];
    case 'READY_TO_MERGE': return ['Merge'];
    case 'MERGED': case 'READY_TO_DEPLOY': return ['Deploy (طبق تنظیم فعلی)'];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Status card (deterministic, Persian)
// ---------------------------------------------------------------------------

export function statusCard(snap: any): StatusCard {
  const s: TaskState = snap.state;
  if (snap.awaitingHuman) {
    return {
      icon: '⚠️', title: 'تصمیم شما لازم است',
      detail: 'سیستم نمی‌تواند این تصمیم حساس را با شواهد موجود به‌تنهایی بگیرد.',
      actionRequired: true,
      actionExplanation:
        `موضوع: ${snap.awaitingHuman.issue}\n` +
        `پیشنهاد سیستم: ${snap.awaitingHuman.recommendedAction}\n` +
        `برای ادامه، در صفحه Task دکمه APPROVE RECOMMENDED ACTION یا Reject را بزنید.`,
    };
  }
  if (s === 'DEPLOYED') return { icon: '✅', title: 'کار با موفقیت تمام و Deploy شد', detail: 'نیازی به اقدام شما نیست.', actionRequired: false };
  if (s === 'MERGED' || s === 'READY_TO_DEPLOY') {
    return snap.deploymentHeld
      ? { icon: '✅', title: 'کار با موفقیت تمام شد', detail: 'کد Merge شده است. Deploy خودکار طبق تنظیم شما متوقف است؛ هر وقت بخواهید می‌توانید از System → Deployment Settings فعالش کنید یا همین Task را دستی Deploy کنید. نیازی به اقدام فوری نیست.', actionRequired: false }
      : { icon: '✅', title: 'کار با موفقیت تمام شد', detail: 'کد Merge شده و برای Deploy آماده است. نیازی به اقدام شما نیست.', actionRequired: false };
  }
  if (s === 'READY_TO_MERGE') return { icon: '✅', title: 'کار انجام شد و منتظر Merge است', detail: 'دروازه‌های لازم سبز هستند.', actionRequired: false };
  if (s === 'FAILED' || s === 'ESCALATED') {
    return { icon: '❌', title: 'Task ناموفق بود یا متوقف شد',
      detail: snap.lastError ? `علت ثبت‌شده: ${snap.lastError}` : 'سیستم نتوانست کار را به‌صورت خودکار کامل کند.',
      actionRequired: true,
      actionExplanation: 'می‌توانید Task را با دکمه Resume دوباره اجرا کنید، یا آن را Cancel کنید.' };
  }
  if (s === 'CANCELLED') return { icon: '🛈', title: 'Task لغو شده است', detail: 'به درخواست مالک متوقف شد.', actionRequired: false };
  if (s === 'PAUSED_RATE_LIMIT') return { icon: '⏳', title: 'به‌دلیل سهمیه اشتراک موقتاً متوقف است', detail: 'پس از باز شدن پنجره سهمیه، با Resume ادامه می‌یابد. هزینه‌ای خرج نمی‌شود.', actionRequired: false };
  return { icon: '⏳', title: 'کار هنوز در حال انجام است',
    detail: `مرحله فعلی: ${faState(s)}${snap.subPhase ? ` (${snap.subPhase})` : ''}. فعلاً نیازی به اقدام شما نیست.`,
    actionRequired: false };
}

function faState(s: string): string {
  const map: Record<string, string> = {
    NEW: 'شروع', DESIGN: 'طراحی', IMPLEMENT: 'پیاده‌سازی', VERIFY: 'تست‌های سریع',
    REVIEW: 'بررسی مستقل Codex', FIX: 'اصلاح', FINAL_ACCEPTANCE: 'پذیرش نهایی',
    AWAITING_HUMAN: 'در انتظار تصمیم شما', READY_TO_MERGE: 'آماده Merge', MERGED: 'Merge شده',
    READY_TO_DEPLOY: 'آماده Deploy', DEPLOYED: 'Deploy شده', PAUSED: 'متوقف',
    PAUSED_RATE_LIMIT: 'توقف سهمیه', ESCALATED: 'ارجاع شده', FAILED: 'ناموفق', CANCELLED: 'لغو شده',
  };
  return map[s] ?? s;
}

// ---------------------------------------------------------------------------
// Deterministic Persian renderer (always available; also the fallback)
// ---------------------------------------------------------------------------

export function deterministicPersian(snap: any, level: DetailLevel): string {
  const L: string[] = [];
  const t = snap.task;
  const running = !FINAL_STATES.includes(snap.state);
  const tests = snap.tests ?? [];
  const latestTests = new Map<string, any>();
  for (const x of tests) latestTests.set(`${x.tier}:${x.name}`, x);
  const okTests = [...latestTests.values()].filter((x) => x.ok).length;
  const badTests = [...latestTests.values()].filter((x) => !x.ok);
  const crit = (snap.findings ?? []).filter((f: any) => f.severity === 'CRITICAL' &&
    !['REJECT', 'DETERMINISTICALLY_REJECTED', 'DEFER'].includes(f.status));

  if (level === 'SIMPLE') {
    L.push('## ۱. چه کاری انجام شد؟');
    L.push(`${t.title}`);
    if ((snap.changes ?? []).length) L.push(`تغییرات کد اعمال شد (${snap.changes.length} مرحله ثبت‌شده).`);
    L.push('');
    L.push('## ۲. آیا موفق شد؟');
    if (snap.state === 'DEPLOYED' || snap.state === 'MERGED' || snap.state === 'READY_TO_DEPLOY' || snap.state === 'READY_TO_MERGE') {
      L.push(`بله. ${okTests} بررسی/تست ثبت‌شده پاس شده‌اند${badTests.length ? ` و ${badTests.length} مورد ناموفق ثبت شده` : ''}.`);
    } else if (snap.state === 'FAILED' || snap.state === 'ESCALATED') {
      L.push(`خیر. ${snap.lastError ? `علت: ${snap.lastError}` : 'سیستم متوقف شد.'}`);
    } else if (snap.legacy) {
      L.push(`این Task قدیمی (V1) است؛ وضعیت نهایی ثبت‌شده: ${faState(snap.state)}.`);
    } else {
      L.push('هنوز تمام نشده است؛ نتیجه نهایی بعداً مشخص می‌شود.');
    }
    L.push('');
    L.push('## ۳. الان وضعیت چیست؟');
    L.push(`وضعیت: ${faState(snap.state)}${running ? ' (در حال اجرا)' : ''}.`);
    if (snap.merge?.ok) L.push('کد با موفقیت Merge شده است.');
    if (snap.deployment?.ok) L.push('روی Production مستقر (Deploy) شده است.');
    else if (snap.deploymentHeld) L.push('Deploy خودکار طبق تنظیم شما متوقف است.');
    L.push('');
    L.push('## ۴. آیا من باید کاری انجام بدهم؟');
    const card = statusCard(snap);
    L.push(card.actionRequired ? `بله. ${card.actionExplanation ?? card.detail}` : 'خیر.');
    if (crit.length) L.push(`⚠️ توجه: ${crit.length} یافته CRITICAL حل‌نشده ثبت شده است.`);
    return L.join('\n');
  }

  // NORMAL
  L.push('## خلاصه');
  L.push(`این گزارش ${running ? '«تا این لحظه»' : 'نهایی'} برای \`${t.taskId}\` است` +
    (running ? ' — Task هنوز تمام نشده است.' : '.'));
  L.push('');
  L.push('## چه کاری از سیستم خواسته شد؟');
  L.push(t.description || t.title);
  L.push('');
  L.push('## وضعیت فعلی چیست؟');
  L.push(`وضعیت: ${faState(snap.state)}${snap.subPhase ? ` (\`${snap.subPhase}\`)` : ''}؛ ریسک: ${String(t.risk).toUpperCase()}؛ شاخه: \`${snap.branch}\`؛ پایه: \`${String(snap.baseSha).slice(0, 9)}\`${snap.headSha ? `؛ HEAD فعلی: \`${String(snap.headSha).slice(0, 9)}\`` : ''}.`);
  L.push('');

  const byAgent = (name: string) => (snap.agents ?? []).filter((a: any) => a.agent === name);
  const agentLine = (name: string, fa: string) => {
    const runs = byAgent(name);
    if (!runs.length) return null;
    const done = runs.filter((a: any) => a.type === 'AGENT_FINISHED').length;
    const failed = runs.filter((a: any) => a.type === 'AGENT_FAILED').length;
    const model = runs.map((a: any) => a.effectiveModel).filter(Boolean).pop();
    const phases = [...new Set(runs.map((a: any) => a.phase).filter(Boolean))].join('، ');
    return `${fa} (${done} اجرای موفق${failed ? `، ${failed} ناموفق` : ''}${model ? `، مدل \`${model}\`` : ''}) — مراحل: ${phases}.`;
  };
  const c1 = agentLine('claude', 'Claude طراحی و داوری را انجام داد');
  const c2 = agentLine('codex', 'Codex به‌صورت مستقل بررسی کرد');
  const c3 = agentLine('claude-code', 'Claude Code پیاده‌سازی و اصلاح را انجام داد');
  if (c1 || c2 || c3) { L.push('## Agent‌ها چه کردند؟'); for (const c of [c1, c2, c3]) if (c) L.push(c); L.push(''); }

  const files = [...new Set((snap.changes ?? []).flatMap((c: any) => c.filesChanged ?? []))];
  if (files.length) {
    L.push('## چه فایل‌هایی تغییر کردند؟');
    for (const f of files.slice(0, 20)) L.push(`- \`${f}\``);
    L.push('');
  }

  if (latestTests.size) {
    L.push('## چه تست‌هایی اجرا شدند؟');
    for (const x of latestTests.values()) L.push(`- ${x.ok ? '✓' : '✗'} \`${x.name}\` (${x.tier}): ${x.detail}`);
    L.push('');
  }
  const det = (snap.deterministicEvidence ?? []);
  if (det.length) {
    L.push('## شواهد قطعی چه می‌گویند؟');
    for (const d of det.slice(0, 15)) L.push(`- ${d.ok ? '✓' : '✗'} \`${d.name}\`: ${d.detail}`);
    L.push('');
  }
  if ((snap.findings ?? []).length) {
    L.push('## یافته‌های بررسی');
    for (const f of snap.findings.slice(0, 12)) {
      L.push(`- \`${f.findingId}\` (${f.severity} → ${f.status}): ${f.claim}`);
    }
    L.push('');
  }
  if (snap.retries || (snap.systemEvents ?? []).length) {
    L.push('## رویدادهای سیستم');
    if (snap.retries) L.push(`- سیستم ${snap.retries} بار به‌صورت خودکار تلاش مجدد کرد.`);
    for (const e of (snap.systemEvents ?? []).slice(0, 10)) {
      if (e.type === 'AUTOMATIC_DEPLOYMENT_HELD') L.push('- Deploy خودکار طبق تنظیم مالک متوقف شد؛ Task در READY_TO_DEPLOY منتظر ماند.');
      else if (e.type === 'HUMAN_DECISION') L.push(`- تصمیم انسانی ثبت شد: ${e.choice ?? ''} توسط ${e.decidedBy ?? ''}.`);
      else if (e.type === 'SETTING_CHANGED') L.push(`- تنظیم \`${e.setting}\` از ${e.from} به ${e.to} تغییر کرد.`);
      else if (e.type === 'POLICY_BLOCK') L.push(`- سیاست ایمنی جلوی تغییر خارج از محدوده را گرفت: \`${e.detail ?? ''}\`.`);
      else if (e.type === 'TASK_CANCELLED') L.push(`- Task توسط ${e.cancelledBy ?? 'مالک'} لغو شد.`);
    }
    L.push('');
  }
  L.push('## Git / Merge / Deploy');
  if (snap.merge?.ok) L.push(`Merge انجام شد: \`${String(snap.merge.mergeSha).slice(0, 9)}\` روی \`origin/main\` (نسخه بررسی‌شده \`${String(snap.merge.approvedSha).slice(0, 9)}\` بود و سیستم برابری آن با HEAD شاخه را قبل از Merge تأیید کرد).`);
  else if (snap.merge && !snap.merge.ok) L.push(`تلاش Merge ناموفق بود: ${snap.merge.detail}. چیزی push نشد.`);
  else L.push('هنوز Merge انجام نشده است.');
  if (snap.deployment?.ok) L.push(`Deploy انجام شد: \`${String(snap.deployment.deployedSha).slice(0, 9)}\`.`);
  else if (snap.deploymentHeld) L.push('Deploy خودکار طبق تنظیم فعلی متوقف است (AUTOMATIC_DEPLOYMENT_HELD).');
  L.push('');
  if ((snap.verified ?? []).length) {
    L.push('## چه چیزهایی تأیید شده‌اند؟');
    for (const v of snap.verified.slice(0, 12)) L.push(`- ${v}`);
    L.push('');
  }
  if ((snap.notVerified ?? []).length) {
    L.push('## چه چیزهایی تأیید نشده‌اند؟');
    for (const v of snap.notVerified.slice(0, 12)) L.push(`- ${v}`);
    L.push('');
  }
  if (running && (snap.pending ?? []).length) {
    L.push('## چه چیزهایی هنوز باقی مانده؟');
    for (const p of snap.pending) L.push(`- ${p}`);
    L.push('');
  }
  const card = statusCard(snap);
  L.push('## آیا اقدام من لازم است؟');
  L.push(card.actionRequired ? `بله. ${card.actionExplanation ?? card.detail}` : 'خیر، نیازی به اقدام شما نیست.');
  if (snap.legacy) { L.push(''); L.push('🛈 این گزارش از شواهد تاریخی V1 بازسازی شده است (V1 LEGACY).'); }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Fable narrative generation (subscription CLI only; deterministic fallback)
// ---------------------------------------------------------------------------

async function generateWithClaude(snap: any, level: DetailLevel): Promise<{ text: string | null; effectiveModel?: string }> {
  // Selftests and emergency ops can force the deterministic path; no model runs.
  if (process.env.AI_V2_REPORT_DISABLE_LLM === '1') return { text: null };
  const sanitized = redactPayload(snap);
  const structure = level === 'SIMPLE'
    ? `گزارش ساده برای یک غیر برنامه‌نویس. حتماً با این چهار پرسش شروع کن و به هر کدام روشن جواب بده:
## ۱. چه کاری انجام شد؟
## ۲. آیا موفق شد؟
## ۳. الان وضعیت چیست؟
## ۴. آیا من باید کاری انجام بدهم؟
بعد از آن حداکثر چند سطر توضیح ساده. از اصطلاحات فنی سنگین پرهیز کن؛ هر جا ناچار شدی، همان اصطلاح انگلیسی را در backtick بگذار.`
    : `گزارش کامل با بخش‌های مرتبط از این فهرست (بخش خالی نساز):
خلاصه / چه کاری خواسته شد؟ / وضعیت فعلی / Claude چه کرد؟ / Codex چه بررسی کرد؟ / Claude Code چه کرد؟ / تغییرات کد و فایل‌ها / تست‌ها / مشکلات پیش‌آمده و نحوه حل / یافته‌ها و اختلاف‌ها / شواهد قطعی / تأییدشده‌ها / تأییدنشده‌ها / Git و Merge / Deploy / Production / آیا اقدام من لازم است؟
هر بخش را با «## عنوان» شروع کن.`;
  const prompt = `تو گزارشگر فارسی سیستم Autopilot هستی. فقط و فقط از SNAPSHOT زیر گزارش بنویس — هیچ رویدادی را از خودت اختراع نکن و هیچ عددی را تغییر نده.

قواعد سخت:
- زبان: فارسی روان و طبیعی. جهت متن راست‌به‌چپ است.
- هر شناسه فنی (نام فایل، مسیر، SHA، دستور، TASK-V2-…، Stage 0، Stage −1، نام مدل) را داخل \`backtick\` بگذار تا LTR بماند.
- Claude و Codex و Claude Code را از هم جدا توضیح بده؛ Codex بازبین مستقل است.
- شواهد قطعی (تست‌ها و بررسی‌های ثبت‌شده) بر ادعای Agent‌ها مقدم است؛ اگر تضاد بود، شواهد را گزارش کن.
- «تأییدشده» و «تأییدنشده» را دقیقاً همان‌طور که در snapshot است حفظ کن؛ چیزی را پنهان یا ارتقا نده.
- رویدادهای تکراری (مثلاً retryها) را در قالب یک روایت کوتاه جمع کن، نه فهرست خام.
- اگر state در ${JSON.stringify(FINAL_STATES)} نیست، این «گزارش تا این لحظه» است و نتیجه نهایی اعلام نکن.
- خروجی فقط متن گزارش است؛ نه JSON، نه مقدمه انگلیسی.

${structure}

SNAPSHOT:
${JSON.stringify(sanitized).slice(0, 90_000)}`;

  const stdout = await new Promise<string | null>((resolve) => {
    const child = execFile(CLAUDE_BIN, ['-p', prompt, '--model', CLAUDE_MODEL, '--output-format', 'json'],
      { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024, env: subscriptionEnv() },
      (err, out) => resolve(err ? null : String(out)));
    child.stdin?.end();
  });
  if (!stdout) return { text: null };
  const env = inspectEnvelope(stdout);
  if (env.kind === 'error' || !env.body.trim()) return { text: null };
  let effectiveModel: string | undefined;
  try {
    const o = JSON.parse(stdout);
    effectiveModel = Object.keys(o.modelUsage ?? {}).find((k) => !/haiku/.test(k));
  } catch { /* envelope already parsed */ }
  return { text: env.body.trim(), effectiveModel };
}

// ---------------------------------------------------------------------------
// Store + cache
// ---------------------------------------------------------------------------

function reportDir(taskId: string): string {
  const d = path.join(STATE_ROOT, 'reports', taskId);
  fs.mkdirSync(d, { recursive: true, mode: 0o750 });
  return d;
}

export function listReports(taskId: string): ReportRecord[] {
  const d = path.join(STATE_ROOT, 'reports', taskId);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}

function findCached(taskId: string, head: string, cursor: number, level: DetailLevel): ReportRecord | null {
  return listReports(taskId).reverse().find((r) =>
    r.identity.taskHEAD === head && r.identity.lastEventId === cursor &&
    r.identity.detailLevel === level && r.identity.language === 'fa') ?? null;
}

/** One generation at a time per (task, level): concurrent clicks share the same run. */
const inflight = new Map<string, Promise<ReportRecord | null>>();

export function generateReport(events: EventStore, taskId: string, level: DetailLevel,
  opts: { force?: boolean } = {}): Promise<ReportRecord | null> {
  const key = `${taskId}:${level}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = generateReportInner(events, taskId, level, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function generateReportInner(events: EventStore, taskId: string, level: DetailLevel,
  opts: { force?: boolean }): Promise<ReportRecord | null> {
  const { snapshot, ms: snapshotMs } = buildSnapshot(events, taskId);
  if (!snapshot) return null;
  const head = String(snapshot.headSha ?? '');
  const cursor = Number(snapshot.cursor ?? 0);

  if (!opts.force) {
    const cached = findCached(taskId, head, cursor, level);
    if (cached) return cached; // identical evidence → identical report; no model usage
  }

  const t0 = Date.now();
  const attempt = await generateWithClaude(snapshot, level);
  const narrative = attempt.text ?? deterministicPersian(snapshot, level);
  const record: ReportRecord = {
    identity: {
      taskId, lastEventId: cursor, taskHEAD: head, generatedAt: new Date().toISOString(),
      reportType: FINAL_STATES.includes(snapshot.state) ? 'FINAL' : 'CURRENT',
      language: 'fa', detailLevel: level, ...(snapshot.legacy ? { legacy: true } : {}),
    },
    statusCard: statusCard(snapshot),
    // Output redaction again — defense in depth even though inputs were sanitized.
    narrative: redact(narrative),
    generator: attempt.text ? (attempt.effectiveModel ?? CLAUDE_MODEL) : 'deterministic-fallback',
    generationMs: Date.now() - t0,
    snapshotMs,
    requestedModel: CLAUDE_MODEL,
    effectiveModel: attempt.text ? attempt.effectiveModel : undefined,
  };
  const file = path.join(reportDir(taskId),
    `${record.identity.generatedAt.replace(/[:.]/g, '-')}-${level}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 1), { mode: 0o640 });
  return record;
}

/** Deterministic-only variant for tests and emergency paths. */
export function generateDeterministic(events: EventStore, taskId: string, level: DetailLevel): ReportRecord | null {
  const { snapshot, ms } = buildSnapshot(events, taskId);
  if (!snapshot) return null;
  return {
    identity: {
      taskId, lastEventId: Number(snapshot.cursor ?? 0), taskHEAD: String(snapshot.headSha ?? ''),
      generatedAt: new Date().toISOString(),
      reportType: FINAL_STATES.includes(snapshot.state) ? 'FINAL' : 'CURRENT',
      language: 'fa', detailLevel: level, ...(snapshot.legacy ? { legacy: true } : {}),
    },
    statusCard: statusCard(snapshot),
    narrative: redact(deterministicPersian(snapshot, level)),
    generator: 'deterministic-fallback', generationMs: 0, snapshotMs: ms,
    requestedModel: CLAUDE_MODEL,
  };
}

/** Persian delta between two cursors — deterministic, cheap. */
export function whatChanged(events: EventStore, taskId: string, sinceCursor: number): string {
  const evs = events.read(taskId).filter((e) => e.seq > sinceCursor);
  if (!evs.length) return 'از گزارش قبلی تاکنون رویداد جدیدی ثبت نشده است.';
  const L: string[] = [`از گزارش قبلی (رویداد ${sinceCursor}) تاکنون ${evs.length} رویداد جدید ثبت شده است:`, ''];
  for (const e of evs.slice(0, 30)) {
    const p = e.payload as any;
    switch (e.type) {
      case 'STATE_CHANGED': L.push(`- وضعیت از ${faState(p.from)} به ${faState(p.to)} تغییر کرد.`); break;
      case 'AGENT_STARTED': L.push(`- \`${e.agent}\` شروع به کار کرد (${e.phase ?? ''}).`); break;
      case 'AGENT_FINISHED': L.push(`- \`${e.agent}\` کارش را تمام کرد.`); break;
      case 'AGENT_FAILED': L.push(`- اجرای \`${e.agent}\` ناموفق بود (${p.failureKind ?? ''}).`); break;
      case 'TEST_RESULT': L.push(`- تست \`${p.name}\`: ${p.ok ? 'پاس شد' : 'ناموفق'} — ${String(p.detail).slice(0, 80)}.`); break;
      case 'DETERMINISTIC_CHECK': L.push(`- بررسی \`${p.name}\`: ${p.ok ? '✓' : '✗'}.`); break;
      case 'FINDING': L.push(`- ${((p.findings ?? []) as any[]).length} یافته جدید از بازبینی ثبت شد.`); break;
      case 'ADJUDICATION': L.push(`- داوری برای \`${p.findingId}\`: ${p.status}.`); break;
      case 'CODE_CHANGE': L.push(`- تغییر کد ثبت شد (HEAD جدید \`${String(p.headSha).slice(0, 9)}\`).`); break;
      case 'MERGE_RESULT': L.push(`- Merge ${p.ok ? 'انجام شد' : `ناموفق بود: ${p.detail}`}.`); break;
      case 'DEPLOY_RESULT': L.push(`- Deploy ${p.ok ? 'انجام شد' : `ناموفق بود: ${p.detail}`}.`); break;
      case 'AUTOMATIC_DEPLOYMENT_HELD': L.push('- Deploy خودکار طبق تنظیم مالک متوقف ماند.'); break;
      case 'HUMAN_DECISION': L.push(`- تصمیم شما ثبت شد: ${p.choice}.`); break;
      default: break;
    }
  }
  return redact(L.join('\n'));
}
