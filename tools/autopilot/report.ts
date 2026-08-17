/**
 * Derived report.
 *
 * Strictly a pure function of the event log: no clock reads, no directory
 * listings, no environment. Deleting the report and rebuilding must produce a
 * byte-identical file, which is what makes the log -- not the report -- the
 * thing worth trusting.
 */
import { AutopilotEvent, Finding, TaskRecord } from './types';
import { EventStore } from './storage/event-store';
import { TaskStore } from './storage/task-store';

function section(title: string): string {
  return `\n## ${title}\n\n`;
}

function bullet(items: string[]): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') + '\n' : '_none recorded_\n';
}

export function buildReport(taskId: string, events: EventStore, tasks: TaskStore): string {
  const log: AutopilotEvent[] = events.read(taskId);
  if (log.length === 0) return `# ${taskId}\n\n_no events recorded_\n`;
  const rec: TaskRecord = tasks.deriveTask(taskId)!;

  const out: string[] = [];
  out.push(`# ${taskId} — ${rec.title}\n`);
  out.push(`- **State:** ${rec.state}\n`);
  out.push(`- **Risk:** ${rec.risk}\n`);
  out.push(`- **Branch:** ${rec.branch}\n`);
  out.push(`- **Created:** ${rec.createdAt}\n`);
  out.push(`- **Events:** ${log.length}\n`);
  out.push(`- **Review rounds:** ${rec.reviewRounds}\n`);
  out.push(`- **Auto-merge:** ${rec.autoMerge ? 'enabled' : 'disabled'}\n`);

  const simulated = log.filter((e) => e.simulated);
  if (simulated.length) {
    out.push(
      `\n> **SIMULATED RUN.** ${simulated.length} event(s) came from fixture replay rather than a live ` +
        `model. Simulated evidence never satisfies reviewer independence and cannot certify a merge.\n`,
    );
  }
  const reconstructed = log.filter((e) => e.reconstructed);
  if (reconstructed.length) {
    const byConf = reconstructed.reduce<Record<string, number>>((acc, e) => {
      const k = e.reconstructionConfidence ?? 'UNKNOWN';
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    out.push(
      `\n> **RECONSTRUCTED HISTORY.** ${reconstructed.length} of ${log.length} events were rebuilt from ` +
        `git and prior reports: ` +
        Object.keys(byConf)
          .sort()
          .map((k) => `${k}=${byConf[k]}`)
          .join(', ') +
        `.\n`,
    );
  }

  // -- timeline -----------------------------------------------------------
  out.push(section('Timeline'));
  for (const e of log) {
    const flags = [
      e.reconstructed ? `reconstructed:${e.reconstructionConfidence ?? '?'}` : '',
      e.simulated ? 'simulated' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const summary = summarize(e);
    out.push(`${String(e.seq).padStart(3, '0')}. \`${e.type}\` (${e.actor})${flags ? ` _[${flags}]_` : ''} — ${summary}\n`);
  }

  // -- findings -----------------------------------------------------------
  const findingEvents = log.filter((e) => e.type === 'FINDING' || e.type === 'DESIGN_REVIEW');
  const allFindings: Finding[] = [];
  for (const e of findingEvents) {
    const fs = (e.payload as any).findings as Finding[] | undefined;
    if (Array.isArray(fs)) allFindings.push(...fs);
  }
  if (allFindings.length) {
    out.push(section('Findings and adjudication'));
    const adjudications = log.filter((e) => e.type === 'ADJUDICATION');
    for (const f of allFindings) {
      const adj = adjudications.find((a) => (a.payload as any).findingId === f.findingId);
      const verdict = adj ? String((adj.payload as any).verdict) : 'NOT ADJUDICATED';
      out.push(`- **${f.findingId}** [${f.severity}/${f.category}] ${f.file} — ${f.claim}\n`);
      out.push(`  - verdict: **${verdict}**\n`);
      if (adj && (adj.payload as any).requiredFix) {
        out.push(`  - required fix: ${(adj.payload as any).requiredFix}\n`);
      }
    }
  }

  // -- test evidence ------------------------------------------------------
  const tests = log.filter((e) => e.type === 'TEST_RESULT');
  if (tests.length) {
    out.push(section('Test evidence'));
    out.push('| tier | suite | exit | passed | failed | skipped | ok |\n');
    out.push('|---|---|---|---|---|---|---|\n');
    for (const t of tests) {
      const p = t.payload as any;
      out.push(
        `| ${p.tier} | ${p.name} | ${p.exitCode} | ${p.passed} | ${p.failed} | ${p.skipped} | ${p.ok ? 'yes' : 'NO'} |\n`,
      );
    }
  }

  // -- verified / not verified (always both) -------------------------------
  const runtime = log.filter((e) => e.type === 'RUNTIME_EVIDENCE');
  const verified: string[] = [];
  const notVerified: string[] = [];
  for (const e of runtime) {
    for (const v of ((e.payload as any).verified as string[]) ?? []) {
      if (!verified.includes(v)) verified.push(v);
    }
    for (const v of ((e.payload as any).notVerified as string[]) ?? []) {
      if (!notVerified.includes(v)) notVerified.push(v);
    }
  }
  for (const e of log.filter((x) => x.type === 'DEFERRED')) {
    const d = `DEFERRED: ${String((e.payload as any).what)} — ${String((e.payload as any).why)}`;
    if (!notVerified.includes(d)) notVerified.push(d);
  }
  for (const e of log.filter((x) => x.type === 'BACKFILL_GAP')) {
    const d = `EVIDENCE GAP: ${String((e.payload as any).what)}`;
    if (!notVerified.includes(d)) notVerified.push(d);
  }

  out.push(section('VERIFIED'));
  out.push(bullet(verified));
  out.push(section('NOT VERIFIED / OUT OF SCOPE'));
  out.push(bullet(notVerified));

  // -- escalations / conflicts --------------------------------------------
  const problems = log.filter(
    (e) => e.type === 'ESCALATION' || e.type === 'EVIDENCE_CONFLICT' || e.type === 'POLICY_BLOCK',
  );
  if (problems.length) {
    out.push(section('Escalations, conflicts and policy blocks'));
    for (const e of problems) {
      const p = e.payload as any;
      out.push(`- \`${e.type}\` ${p.reason ?? p.rule ?? p.detail ?? ''} ${p.detail && p.rule ? `— ${p.detail}` : ''}\n`);
    }
  }

  out.push(section('Observatory counters'));
  out.push(bullet(counters(log)));
  out.push(
    `\n> **SAMPLE SIZE: ${countTasksRepresented(log)} TASK(S).** These counters are recorded so that ` +
      `accuracy can be computed later. They are not a leaderboard and are not statistically meaningful ` +
      `at this sample size.\n`,
  );

  return out.join('');
}

function countTasksRepresented(log: AutopilotEvent[]): number {
  return new Set(log.map((e) => e.taskId)).size;
}

function counters(log: AutopilotEvent[]): string[] {
  const findings = log.filter((e) => e.type === 'FINDING' || e.type === 'DESIGN_REVIEW');
  const totalFindings = findings.reduce(
    (n, e) => n + (((e.payload as any).findings as unknown[]) ?? []).length,
    0,
  );
  const adjudications = log.filter((e) => e.type === 'ADJUDICATION');
  const confirmed = adjudications.filter((e) => (e.payload as any).verdict === 'CONFIRMED').length;
  const partial = adjudications.filter((e) => (e.payload as any).verdict === 'PARTIAL').length;
  const rejected = adjudications.filter((e) => (e.payload as any).verdict === 'REJECTED').length;
  const fixes = log.filter((e) => e.type === 'FIX').length;
  const rounds = log.filter((e) => e.type === 'FINDING' && (e.payload as any).roundStart).length;
  const runtimeOverrules = log.filter((e) => e.type === 'EVIDENCE_CONFLICT').length;
  const gaps = log.filter((e) => e.type === 'BACKFILL_GAP').length;
  const deferred = log.filter((e) => e.type === 'DEFERRED').length;

  return [
    `findings raised: ${totalFindings}`,
    `adjudicated CONFIRMED: ${confirmed}`,
    `adjudicated PARTIAL: ${partial}`,
    `adjudicated REJECTED: ${rejected}`,
    `fix rounds executed: ${fixes}`,
    `review rounds: ${rounds}`,
    `evidence conflicts: ${runtimeOverrules}`,
    `known evidence gaps: ${gaps}`,
    `explicitly deferred items: ${deferred}`,
    `rate-limit pauses: ${log.filter((e) => e.type === 'PAUSED_RATE_LIMIT').length}`,
  ];
}

function summarize(e: AutopilotEvent): string {
  const p = e.payload as any;
  switch (e.type) {
    case 'TASK_CREATED':
      return `${p.title} (risk=${p.risk})`;
    case 'STATE_TRANSITION':
      return `${p.from} → ${p.to}`;
    case 'DESIGN_DECISION':
      return p.final ? `FINAL design (${(p.design?.scopeAllowlist ?? []).length} allowlisted paths)` : 'draft design';
    case 'DESIGN_REVIEW':
      return `verdict=${p.verdict} findings=${p.findingCount ?? (p.findings ?? []).length}`;
    case 'IMPLEMENTATION':
      return `${p.status} (${(p.filesChanged ?? []).length} files)`;
    case 'FINDING':
      return `round ${p.round ?? '?'}: ${(p.findings ?? []).length} finding(s)`;
    case 'ADJUDICATION':
      return `${p.findingId} → ${p.verdict}`;
    case 'FIX':
      return `round ${p.round}: ${p.status}`;
    case 'TEST_RESULT':
      return `${p.name}: exit=${p.exitCode} ${p.passed}p/${p.failed}f/${p.skipped}s`;
    case 'RUNTIME_EVIDENCE':
      return `${p.tier} acceptance ok=${p.ok}`;
    case 'VERDICT':
      return String(p.verdict);
    case 'DEFERRED':
      return `${p.what} — ${p.why}`;
    case 'PAUSED_RATE_LIMIT':
      return `${p.provider} quota reached; paused from ${p.pausedFrom} (no API fallback)`;
    case 'ESCALATION':
      return String(p.reason);
    case 'READY_TO_MERGE':
      return `${p.branch} @ ${String(p.head).slice(0, 9)} (auto-merge ${p.autoMerge ? 'on' : 'off'})`;
    case 'MERGED':
      return String(p.sha ?? '');
    case 'BACKFILL_GAP':
      return `${p.what} — ${p.why}`;
    case 'EVIDENCE_CONFLICT':
      return String(p.detail);
    case 'POLICY_BLOCK':
      return `${p.rule}: ${p.detail}`;
    default:
      return '';
  }
}
