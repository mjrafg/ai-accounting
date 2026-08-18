/**
 * Context builders — derive packs from machine evidence only.
 *
 * Everything here is read out of the task's own append-only event log, the
 * deterministic event index and the SHA-pinned graph. Nothing is inferred by an
 * LLM, so a pack can always be reconstructed for a historical task.
 *
 * Three packs, deliberately different in what they are allowed to contain:
 *   TASK  — for Claude/Claude Code continuing inside one task
 *   FIX   — for a repair run, built from the ADJUDICATION, not the raw finding
 *   MAP   — for Codex: structure only, never another agent's conclusions
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventStore, deriveTask, allFindings } from './store';
import { ContextEntry, makeEntry, render, RenderedContext, loadTaskContext, upsertEntries } from './context';
import { eventCoupling } from './eventindex';
import * as graphify from './graphify';

function sha256File(p: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; }
}

/** Machine FACTs about the current task state. */
export function collectFacts(events: EventStore, taskId: string, cwd: string): ContextEntry[] {
  const rec = deriveTask(events, taskId);
  if (!rec) return [];
  const evs = events.read(taskId);
  const out: ContextEntry[] = [];
  const add = (kind: ContextEntry['kind'], observation: string, verification: ContextEntry['verification'],
    evidence: string, checkedBy: string | null = null) =>
    out.push(makeEntry({ kind, observation, verification, evidence, checkedBy, asOfSha: rec.baseSha, taskId }));

  add('FACT', `Task base commit is ${rec.baseSha}.`, 'CHECKED', 'TASK_CREATED event', 'git rev-parse');

  // Changed files with content hashes — the cheapest way for a later agent to
  // tell whether what it was told still matches the tree it is looking at.
  const changed = new Set<string>();
  for (const e of evs) if (e.type === 'CODE_CHANGE') for (const f of ((e.payload as any).filesChanged ?? [])) changed.add(String(f));
  for (const f of [...changed].slice(0, 25)) {
    const h = sha256File(path.join(cwd, f));
    add('FACT', `File currently changed in this task: ${f}${h ? ` (sha256:${h})` : ''}.`, 'CHECKED',
      'CODE_CHANGE event + file hash', 'sha256sum');
  }

  // Files a previous invocation actually opened (machine-recorded, not claimed).
  const inspected = new Set<string>();
  for (const e of evs) {
    if (e.type !== 'EVIDENCE') continue;
    const re = (e.payload as any).reviewEvidence;
    if (re?.filesInspected) for (const f of re.filesInspected) inspected.add(String(f));
  }
  const notChanged = [...inspected].filter((f) => !changed.has(f)).slice(0, 20);
  if (notChanged.length) {
    add('FACT', `Files already inspected earlier in this task: ${notChanged.join(', ')}.`, 'CHECKED',
      'machine-recorded tool evidence', 'transcript tool-evidence parser');
  }

  // Deterministic results already obtained.
  const latest = new Map<string, any>();
  for (const e of evs) if (e.type === 'TEST_RESULT') latest.set(String((e.payload as any).name), e.payload);
  for (const [name, p] of latest) {
    add('FACT', `Check "${name}" last ran with result ${(p as any).ok ? 'pass' : 'fail'}: ${String((p as any).detail).slice(0, 120)}.`,
      'CHECKED', 'TEST_RESULT event', name);
  }

  // Adjudicated findings — the decision, not the reviewer's phrasing.
  for (const f of allFindings(events, taskId)) {
    if (f.status === 'UNRESOLVED') continue;
    add('OBSERVATION', `Finding ${f.findingId} (${f.severity}) was adjudicated ${f.status}: ${f.claim.slice(0, 140)}`,
      f.decisionSource === 'deterministic' ? 'CHECKED' : 'OBSERVED',
      f.evidence ? String(f.evidence).slice(0, 160) : 'ADJUDICATION event',
      f.decisionSource === 'deterministic' ? 'deterministic check' : null);
  }

  // Event coupling: this repository wires modules together through events far
  // more than through imports, so it belongs in the facts, not in a footnote.
  try {
    const ec = eventCoupling(cwd, [...changed]);
    if (ec.events.length) {
      add('FACT', `Events touched by the changed files: ${ec.events.slice(0, 8).join(', ')}.`, 'CHECKED',
        'deterministic event-coupling index', 'eventindex');
    }
    for (const r of ec.rationale.slice(0, 6)) {
      add('FACT', `Event coupling: ${r}`, 'CHECKED', 'deterministic event-coupling index', 'eventindex');
    }
    if (ec.specs.length) {
      add('FACT', `Specs covering event-coupled modules: ${ec.specs.slice(0, 8).join(', ')}.`, 'CHECKED',
        'deterministic event-coupling index', 'eventindex');
    }
  } catch { /* coupling is additive */ }

  // Graph provenance, so a reader can tell whether the map matches this tree.
  const use = graphify.graphFor(rec.baseSha);
  add('FACT', use.usable
    ? `Graph available for this exact commit (graphSourceSha ${use.sha}, ${use.meta.nodeCount} nodes); interface graphify-task.`
    : `Graph state for this commit: ${(use as any).reason}. ${(use as any).detail}`,
    'CHECKED', 'graphify cache metadata', 'graphify-task status');

  return out;
}

/** One-line orientation derived from FACTs. Navigation only, never proof. */
export function summarize(facts: ContextEntry[], taskId: string, baseSha: string): ContextEntry | null {
  const files = facts.filter((f) => f.observation.startsWith('File currently changed'))
    .map((f) => f.observation.replace(/^File currently changed in this task: /, '').replace(/ \(sha256:.*\)\.$/, ''));
  if (!files.length) return null;
  const dirs = [...new Set(files.map((f) => path.dirname(f)))].slice(0, 3);
  return makeEntry({
    kind: 'SUMMARY', taskId, asOfSha: baseSha, checkedBy: null, verification: 'OBSERVED',
    observation: `Work in this task centres on ${dirs.join(', ')} (${files.length} file(s) changed so far).`,
    evidence: 'derived from CODE_CHANGE facts',
  });
}

const DESCRIPTIVE_NOTE =
  'This block describes the current state of the task and is navigation context only. ' +
  'Current source is authoritative: confirm anything here against the files before relying on it. ' +
  'If something here is wrong, report it in contextDisputes with the evidence you observed.';

/** TASK pack for Claude / Claude Code continuing inside the same task. */
export function buildTaskPack(events: EventStore, taskId: string, cwd: string): RenderedContext | null {
  const rec = deriveTask(events, taskId);
  if (!rec) return null;
  const facts = collectFacts(events, taskId, cwd);
  if (!facts.length) return null;
  const sum = summarize(facts, taskId, rec.baseSha);
  const entries = sum ? [...facts, sum] : facts;
  upsertEntries(taskId, rec.baseSha, entries);

  const stored = loadTaskContext(taskId);
  const header = [
    'TASK CONTEXT',
    `task: ${taskId}`,
    `TASK_BASE_SHA: ${rec.baseSha}`,
    `goal: ${rec.title.slice(0, 160)}`,
    `state: ${rec.state}`,
    DESCRIPTIVE_NOTE,
    '',
  ].join('\n');
  return render(header, stored?.entries ?? entries, 'TASK', events, taskId);
}

/**
 * FIX pack. The builder receives the ADJUDICATED required change: a reviewer's
 * proposed fix is an opinion, and the adjudication is what actually decided the
 * scope — sometimes by correcting the reviewer.
 */
export function buildFixPack(events: EventStore, taskId: string, cwd: string, findingIds: string[]):
  { rendered: RenderedContext; body: any } | null {
  const rec = deriveTask(events, taskId);
  if (!rec) return null;
  const evs = events.read(taskId);
  const findings = allFindings(events, taskId).filter((f) => findingIds.includes(f.findingId));
  if (!findings.length) return null;

  const adjudications = evs.filter((e) => e.type === 'ADJUDICATION')
    .map((e) => e.payload as any)
    .filter((p) => findingIds.includes(String(p.findingId)));

  const changed = new Set<string>();
  for (const e of evs) if (e.type === 'CODE_CHANGE') for (const f of ((e.payload as any).filesChanged ?? [])) changed.add(String(f));
  const specs = new Set<string>();
  for (const e of evs) if (e.type === 'EVIDENCE' && (e.payload as any).impactSpecs) {
    for (const s of (e.payload as any).impactSpecs) specs.add(String(s));
  }

  const body = {
    taskId, baseSha: rec.baseSha, generatedAt: new Date().toISOString(),
    findings: findings.map((f) => {
      const adj = adjudications.find((a) => String(a.findingId) === f.findingId);
      const finderStatement = f.claim;
      const adjudicatedChange = adj?.evidence ? String(adj.evidence) : f.claim;
      // Divergence is recorded only when the adjudication genuinely reframed the
      // finding; otherwise it is noise.
      const divergence = adj && adj.evidence && String(adj.evidence).trim() &&
        String(adj.evidence).trim() !== f.claim.trim() ? String(adj.evidence) : null;
      return {
        findingId: f.findingId, severity: f.severity, finder: 'Codex',
        finderStatement,
        adjudication: f.status,
        adjudicationSource: f.decisionSource ?? 'agent',
        requiredChange: adjudicatedChange,
        adjudicationDivergence: divergence,
        relevantFiles: [f.file, ...[...changed]].filter(Boolean).slice(0, 8),
      };
    }),
    changedFiles: [...changed].slice(0, 25),
    relevantTests: [...specs].slice(0, 10),
  };

  const entries: ContextEntry[] = [];
  const add = (kind: ContextEntry['kind'], observation: string, evidence: string,
    verification: ContextEntry['verification'] = 'CHECKED', checkedBy: string | null = 'ADJUDICATION event') =>
    entries.push(makeEntry({ kind, observation, verification, evidence, checkedBy, asOfSha: rec.baseSha, taskId }));

  for (const f of body.findings) {
    add('FACT', `Finding ${f.findingId} (${f.severity}) reported by ${f.finder}: ${f.finderStatement.slice(0, 200)}`,
      'FINDING event');
    add('FACT', `Adjudication for ${f.findingId}: ${f.adjudication} (source: ${f.adjudicationSource}).`,
      'ADJUDICATION event');
    add('FACT', `Adjudicated required change for ${f.findingId}: ${String(f.requiredChange).slice(0, 260)}`,
      'ADJUDICATION event');
    if (f.adjudicationDivergence) {
      add('OBSERVATION', `Adjudication for ${f.findingId} reframed the reviewer's statement; the adjudicated wording above is the operative one.`,
        'ADJUDICATION vs FINDING comparison', 'OBSERVED', null);
    }
    if (f.relevantFiles.length) add('FACT', `Files associated with ${f.findingId}: ${f.relevantFiles.join(', ')}.`, 'FINDING + CODE_CHANGE events');
  }
  if (body.changedFiles.length) add('FACT', `Files currently changed in this task: ${body.changedFiles.join(', ')}.`, 'CODE_CHANGE events');
  if (body.relevantTests.length) add('FACT', `Tests selected as relevant: ${body.relevantTests.join(', ')}.`, 'impact analysis');

  const header = [
    'FIX CONTEXT',
    `task: ${taskId}`,
    `TASK_BASE_SHA: ${rec.baseSha}`,
    DESCRIPTIVE_NOTE,
    'The adjudicated required change above is the operative scope; the reviewer\'s raw proposal is included only for provenance.',
    '',
  ].join('\n');
  return { rendered: render(header, entries, 'FIX', events, taskId), body };
}

/**
 * MAP pack for Codex. Structure only — changed files with hashes, base SHA,
 * blast radius and relevant tests. No design conclusions, no prior findings, no
 * adjudications, no summaries: reviewer independence is the point, so the
 * reviewer gets the map and forms its own opinion from current source.
 */
export function buildCodexMap(events: EventStore, taskId: string, cwd: string,
  extras: { graphFiles?: string[]; protectedPaths?: string[] } = {}): RenderedContext | null {
  const rec = deriveTask(events, taskId);
  if (!rec) return null;
  const evs = events.read(taskId);
  const changed = new Set<string>();
  for (const e of evs) if (e.type === 'CODE_CHANGE') for (const f of ((e.payload as any).filesChanged ?? [])) changed.add(String(f));
  if (!changed.size) return null;

  const entries: ContextEntry[] = [];
  const add = (observation: string, evidence: string, checkedBy: string | null) =>
    entries.push(makeEntry({ kind: 'FACT', observation, verification: 'CHECKED', evidence, checkedBy,
      asOfSha: rec.baseSha, taskId }));

  add(`Task base commit is ${rec.baseSha}.`, 'TASK_CREATED event', 'git rev-parse');
  for (const f of [...changed].slice(0, 25)) {
    const h = sha256File(path.join(cwd, f));
    add(`Changed file: ${f}${h ? ` (sha256:${h})` : ''}.`, 'CODE_CHANGE event + file hash', 'sha256sum');
  }
  const specs = new Set<string>();
  for (const e of evs) if (e.type === 'EVIDENCE' && (e.payload as any).impactSpecs) {
    for (const s of (e.payload as any).impactSpecs) specs.add(String(s));
  }
  if (specs.size) add(`Tests selected by impact analysis: ${[...specs].slice(0, 10).join(', ')}.`, 'impact analysis', 'affectedSpecs');

  try {
    const ec = eventCoupling(cwd, [...changed]);
    if (ec.events.length) add(`Events touched: ${ec.events.slice(0, 8).join(', ')}.`, 'event-coupling index', 'eventindex');
    if (ec.coupledFiles.length) add(`Event-coupled files: ${ec.coupledFiles.slice(0, 10).join(', ')}.`, 'event-coupling index', 'eventindex');
  } catch { /* additive */ }

  if (extras.graphFiles?.length) {
    add(`Graph blast radius files: ${extras.graphFiles.slice(0, 15).join(', ')}.`, 'graphify affected', 'graphify-task');
  }
  if (extras.protectedPaths?.length) {
    add(`Protected paths in this repository: ${extras.protectedPaths.slice(0, 8).join(', ')}.`, 'policy configuration', 'policy');
  }

  const header = [
    'STRUCTURAL MAP',
    `task: ${taskId}`,
    `TASK_BASE_SHA: ${rec.baseSha}`,
    'This is structure only: no prior design decisions, findings or adjudications are included, so your review stays independent.',
    'Current source is authoritative; open the files before forming a material finding.',
    '',
  ].join('\n');
  return render(header, entries, 'MAP', events, taskId);
}
