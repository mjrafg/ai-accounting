/**
 * Structured Context Memory — Phase 1.
 *
 * Purpose: stop each agent invocation inside one task from rediscovering what a
 * previous invocation in the SAME task already established. Graphify remains the
 * repository-wide map; this is small, progressive and SHA-aware.
 *
 * The governing rule is that context DESCRIBES the system and never DIRECTS the
 * agent. Storing "do not change X" would quietly create a second policy engine
 * that no one reviews, so imperative phrasing is rejected at write time
 * (`assertDescriptive`) rather than merely discouraged. Restrictions belong in
 * core/policy.ts; what the owner wants belongs in the task request.
 *
 * Every entry is typed and carries its own verification status, because the
 * difference between "a deterministic check proves this" and "an agent saw this
 * once" is exactly the difference that makes stale context dangerous.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { STATE_ROOT, EventStore } from './store';

const ROOT = () => path.join(STATE_ROOT, 'context');
const TASKS = () => path.join(ROOT(), 'tasks');
const FIXES = () => path.join(ROOT(), 'fixes');
const AUDIT = () => path.join(ROOT(), 'audit', 'context-events.jsonl');

/** ~4 bytes/token is close enough for a budget guard. */
export const TOKEN_BUDGET = 2000;
const BYTE_BUDGET = TOKEN_BUDGET * 4;

export type EntryKind = 'FACT' | 'SUMMARY' | 'OBSERVATION';
export type Verification = 'CHECKED' | 'OBSERVED' | 'CONTRADICTED' | 'UNVERIFIED';

export interface ContextEntry {
  id: string;
  kind: EntryKind;
  /** Descriptive statement. Never an instruction. */
  observation: string;
  verification: Verification;
  /** What backs it: a check name, a file path, a graph query, a test id. */
  evidence: string;
  /** Deterministic check that proves it. Required for CHECKED, else null. */
  checkedBy: string | null;
  asOfSha: string;
  taskId: string;
  at: string;
}

/**
 * Imperative/policy phrasing that must never enter context. Written as whole
 * words so ordinary description ("the form keeps focus on submit") is unaffected.
 */
const IMPERATIVE = [
  /\bdo not\b/i, /\bdon't\b/i, /\bmust (not )?\b/i, /\bnever\b/i, /\balways\b/i,
  /\bshould (not )?\b/i, /\bkeep\b/i, /\bpreserve\b/i, /\brequired to\b/i,
  /\bforbidden\b/i, /\bavoid\b/i, /\bensure\b/i,
];

export function isDescriptive(text: string): { ok: boolean; matched?: string } {
  for (const re of IMPERATIVE) {
    const m = re.exec(text);
    if (m) return { ok: false, matched: m[0] };
  }
  return { ok: true };
}

function assertDescriptive(text: string): void {
  const v = isDescriptive(text);
  if (!v.ok) {
    throw new Error(`context entries describe state, they do not instruct: "${v.matched}" in "${text.slice(0, 80)}"`);
  }
}

export function makeEntry(input: Omit<ContextEntry, 'id' | 'at'> & { id?: string }): ContextEntry {
  assertDescriptive(input.observation);
  // CHECKED is the only status that asserts proof, so it must name the check.
  const verification: Verification =
    input.verification === 'CHECKED' && !input.checkedBy ? 'OBSERVED' : input.verification;
  const id = input.id ?? `CTX-${crypto.createHash('sha256')
    .update(`${input.taskId}|${input.kind}|${input.observation}`).digest('hex').slice(0, 10)}`;
  return { ...input, verification, id, at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Storage — atomic writes, append-only audit
// ---------------------------------------------------------------------------

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: 0o640 });
  fs.renameSync(tmp, file);
}

/**
 * Append-only audit. Reconstructing what context an agent actually received
 * during a historical task depends on this never being rewritten.
 */
export function audit(event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT()), { recursive: true, mode: 0o750 });
    fs.appendFileSync(AUDIT(), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } catch { /* auditing must never break a task */ }
}

export interface TaskContext {
  taskId: string;
  baseSha: string;
  updatedAt: string;
  entries: ContextEntry[];
}

export function loadTaskContext(taskId: string): TaskContext | null {
  try { return JSON.parse(fs.readFileSync(path.join(TASKS(), `${taskId}.json`), 'utf8')); } catch { return null; }
}

export function saveTaskContext(ctx: TaskContext): void {
  writeAtomic(path.join(TASKS(), `${ctx.taskId}.json`), JSON.stringify(ctx, null, 1));
  audit({ type: 'CONTEXT_SAVED', taskId: ctx.taskId, entries: ctx.entries.length, baseSha: ctx.baseSha });
}

export function upsertEntries(taskId: string, baseSha: string, entries: ContextEntry[]): TaskContext {
  const cur = loadTaskContext(taskId) ?? { taskId, baseSha, updatedAt: '', entries: [] };
  const byId = new Map(cur.entries.map((e) => [e.id, e]));
  for (const e of entries) {
    const prev = byId.get(e.id);
    // A contradiction is sticky for the rest of the task. Routine regeneration
    // re-derives the same FACT with the same id and would otherwise silently
    // resurrect a statement an agent just disproved; clearing it takes the
    // explicit reverify() path, which records who re-proved it.
    if (prev?.verification === 'CONTRADICTED') continue;
    byId.set(e.id, e);
  }
  const ctx: TaskContext = { taskId, baseSha, updatedAt: new Date().toISOString(), entries: [...byId.values()] };
  saveTaskContext(ctx);
  return ctx;
}

/**
 * Clears a contradiction, but only against a named deterministic check. This is
 * the single way a CONTRADICTED entry becomes usable again.
 */
export function reverify(taskId: string, entryId: string, checkedBy: string, evidence: string): boolean {
  const ctx = loadTaskContext(taskId);
  const e = ctx?.entries.find((x) => x.id === entryId);
  if (!ctx || !e || !checkedBy) return false;
  e.verification = 'CHECKED';
  e.checkedBy = checkedBy;
  e.evidence = `${e.evidence} | re-verified by ${checkedBy}: ${evidence.slice(0, 160)}`;
  saveTaskContext(ctx);
  audit({ type: 'CONTEXT_REVERIFIED', taskId, entryId, checkedBy });
  return true;
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export interface Dispute { entryId: string; observed: string; evidence: string }

/**
 * Marks disputed entries CONTRADICTED so they stop being treated as current
 * truth. A contradiction is a data-quality signal, not an escalation: it never
 * interrupts the owner on its own.
 */
export function applyDisputes(taskId: string, disputes: Dispute[], events: EventStore, reportedBy: string):
  { applied: number; unknown: string[] } {
  const ctx = loadTaskContext(taskId);
  if (!ctx || !disputes.length) return { applied: 0, unknown: disputes.map((d) => d.entryId) };
  const unknown: string[] = [];
  let applied = 0;
  for (const d of disputes) {
    const e = ctx.entries.find((x) => x.id === d.entryId);
    if (!e) { unknown.push(d.entryId); continue; }
    e.verification = 'CONTRADICTED';
    e.evidence = `${e.evidence} | CONTRADICTED by ${reportedBy}: ${String(d.evidence).slice(0, 200)}`;
    applied += 1;
    events.append({ taskId, type: 'CONTEXT_CONTRADICTED', payload: {
      entryId: e.id, kind: e.kind, statement: e.observation.slice(0, 200),
      observed: String(d.observed).slice(0, 200), evidence: String(d.evidence).slice(0, 200),
      reportedBy, resolution: 'entry no longer treated as current; resolved by current source/deterministic evidence' } });
    audit({ type: 'CONTEXT_CONTRADICTED', taskId, entryId: e.id, reportedBy });
  }
  if (applied) saveTaskContext(ctx);
  return { applied, unknown };
}

// ---------------------------------------------------------------------------
// Rendering + budget
// ---------------------------------------------------------------------------

export interface RenderedContext {
  text: string;
  type: 'TASK' | 'FIX' | 'MAP';
  bytes: number;
  tokensApprox: number;
  entries: number;
  counts: Record<string, number>;
  condensed: boolean;
  /** FACTs withheld for budget, announced in the text rather than dropped silently. */
  elided: number;
}

function counts(entries: ContextEntry[]): Record<string, number> {
  const c: Record<string, number> = { FACT: 0, SUMMARY: 0, OBSERVATION: 0, CHECKED: 0, OBSERVED: 0, CONTRADICTED: 0, UNVERIFIED: 0 };
  for (const e of entries) { c[e.kind] += 1; c[e.verification] += 1; }
  return c;
}

/**
 * Renders within the token budget. Condensing drops SUMMARY first (it is
 * navigation only), then trims OBSERVATIONs; FACTs are never silently dropped —
 * exceeding the budget on FACTs alone is reported instead.
 */
export function render(header: string, entries: ContextEntry[], type: RenderedContext['type'],
  events?: EventStore, taskId?: string): RenderedContext {
  const usable = entries.filter((e) => e.verification !== 'CONTRADICTED');
  const line = (e: ContextEntry) =>
    `- [${e.kind}/${e.verification}] ${e.observation}${e.evidence ? ` (evidence: ${e.evidence})` : ''}`;

  let chosen = usable;
  let condensed = false;
  let elided = 0;
  let text = `${header}\n${chosen.map(line).join('\n')}`;

  if (Buffer.byteLength(text) > BYTE_BUDGET) {
    condensed = true;
    chosen = usable.filter((e) => e.kind !== 'SUMMARY');
    text = `${header}\n${chosen.map(line).join('\n')}`;
    while (Buffer.byteLength(text) > BYTE_BUDGET && chosen.some((e) => e.kind === 'OBSERVATION')) {
      const i = chosen.map((e) => e.kind).lastIndexOf('OBSERVATION');
      chosen = chosen.filter((_, n) => n !== i);
      text = `${header}\n${chosen.map(line).join('\n')}`;
    }
    // If FACTs alone still exceed the budget, elide the tail EXPLICITLY. The
    // reader is told exactly how many entries were withheld and where the full
    // set lives, so nothing critical disappears without a trace.
    if (Buffer.byteLength(text) > BYTE_BUDGET) {
      const all = chosen;
      let keep = all.length;
      const note = (omitted: number) =>
        `- [FACT/CHECKED] ${omitted} further recorded fact(s) omitted here for the context budget; the complete set is in the task context store.`;
      while (keep > 1) {
        const candidate = `${header}\n${all.slice(0, keep).map(line).join('\n')}\n${note(all.length - keep)}`;
        if (Buffer.byteLength(candidate) <= BYTE_BUDGET) break;
        keep -= Math.max(1, Math.floor(keep / 8));
      }
      chosen = all.slice(0, keep);
      text = `${header}\n${chosen.map(line).join('\n')}\n${note(all.length - keep)}`;
      elided = all.length - keep;
    }
    if (events && taskId) {
      events.append({ taskId, type: 'NOTE', payload: {
        contextBudgetExceeded: { budgetTokens: TOKEN_BUDGET, entriesBefore: usable.length,
          entriesAfter: chosen.length, factsRetained: chosen.filter((e) => e.kind === 'FACT').length,
          factsElided: elided } } });
    }
    audit({ type: 'CONTEXT_BUDGET_EXCEEDED', taskId, before: usable.length, after: chosen.length });
  }
  const bytes = Buffer.byteLength(text);
  return { text, type, bytes, tokensApprox: Math.ceil(bytes / 4), entries: chosen.length,
    counts: counts(chosen), condensed, elided };
}

export function fixPath(taskId: string, findingId: string): string {
  return path.join(FIXES(), `${taskId}-${findingId}.json`);
}
export function saveFixContext(taskId: string, findingId: string, body: unknown): void {
  writeAtomic(fixPath(taskId, findingId), JSON.stringify(body, null, 1));
  audit({ type: 'FIX_CONTEXT_SAVED', taskId, findingId });
}
export function loadFixContext(taskId: string, findingId: string): any | null {
  try { return JSON.parse(fs.readFileSync(fixPath(taskId, findingId), 'utf8')); } catch { return null; }
}
