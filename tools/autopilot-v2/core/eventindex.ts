/**
 * Deterministic event-coupling index.
 *
 * Why this exists: in this codebase modules are wired together far more by
 * events than by imports — measured on origin/main, 169 files carry @OnEvent,
 * 24 are subscribers, 13 are queue processors, and there are 336 emit calls.
 * Graphify's edge relations are purely structural (imports / imports_from /
 * contains / calls / references / inherits) — it models NO event edge, so this
 * index supplements it rather than pretending the graph knows something it
 * does not.
 *
 * The previous impact analysis searched only `*.spec.ts` for event names, and
 * zero spec files reference events — so the event branch never once fired in
 * eleven recorded analyses. This walks the real chain instead:
 *
 *   changed file → events it EMITS      → files that LISTEN  → their specs
 *   changed file → events it LISTENS to → files that EMIT    → their specs
 *
 * Everything here is regex/AST-lite over current source: no agent, no network,
 * fully reproducible.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface EventCoupling {
  /** Event names the changed files emit or listen to. */
  events: string[];
  /** Source files coupled through those events (subscribers, emitters, workers). */
  coupledFiles: string[];
  /** Spec files for the coupled modules. */
  specs: string[];
  rationale: string[];
}

const SERVER_SRC = 'packages/server/src';

/** `events.saleInvoice.onCreated` — the canonical form in this codebase. */
const EVENT_REF = /events\.[A-Za-z0-9_]+\.[A-Za-z0-9_.]+/g;

function rg(worktree: string, pattern: string, globs: string[]): string[] {
  // grep is used deliberately: no shell, fixed argv, bounded output.
  const args = ['-rl', '--include=*.ts', '-e', pattern, path.join(worktree, SERVER_SRC)];
  void globs;
  const r = spawnSync('grep', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return (r.stdout ?? '').split('\n').filter(Boolean).map((f) => path.relative(worktree, f));
}

function readIf(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** Specs that plausibly cover a source file: same directory, or same basename. */
function specsFor(worktree: string, relFile: string): string[] {
  const out = new Set<string>();
  const dir = path.dirname(relFile);
  const absDir = path.join(worktree, dir);
  try {
    for (const f of fs.readdirSync(absDir)) if (f.endsWith('.spec.ts')) out.add(path.join(dir, f));
  } catch { /* directory may not exist in this worktree */ }
  const base = path.basename(relFile).replace(/\.ts$/, '');
  for (const hit of rg(worktree, base, [])) if (hit.endsWith('.spec.ts')) out.add(hit);
  return [...out];
}

/**
 * Builds the coupling for a set of changed files. Bounded on purpose: a change
 * touching a very common event should not select the entire suite.
 */
export function eventCoupling(worktree: string, changedFiles: string[],
  limits = { maxEvents: 12, maxCoupledFiles: 40, maxSpecs: 40 }): EventCoupling {
  const events = new Set<string>();
  const coupledFiles = new Set<string>();
  const specs = new Set<string>();
  const rationale: string[] = [];

  const srcChanged = changedFiles.filter((f) => f.startsWith('packages/server/') && f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  // 1. Which events do the changed files touch (emit OR listen to)?
  for (const f of srcChanged) {
    const text = readIf(path.join(worktree, f));
    if (!text) continue;
    for (const m of text.match(EVENT_REF) ?? []) {
      if (events.size < limits.maxEvents) events.add(m);
    }
    // Queue/worker coupling: a changed processor is coupled to its queue name.
    for (const m of text.matchAll(/@Processor\(\s*['"`]([\w.-]+)['"`]/g)) {
      const queue = m[1];
      rationale.push(`${f}: is a queue processor for "${queue}"`);
      for (const hit of rg(worktree, queue, [])) {
        if (hit !== f && coupledFiles.size < limits.maxCoupledFiles) {
          coupledFiles.add(hit);
          rationale.push(`${hit}: shares queue "${queue}" with ${f}`);
        }
      }
    }
    // A changed file that ENQUEUES work couples to the processor of that queue.
    for (const m of text.matchAll(/BullQueue\w*\(\s*['"`]([\w.-]+)['"`]|\bqueue\.add\(\s*['"`]([\w.-]+)['"`]/g)) {
      const queue = m[1] ?? m[2];
      if (!queue) continue;
      for (const hit of rg(worktree, queue, [])) {
        if (hit !== f && coupledFiles.size < limits.maxCoupledFiles) {
          coupledFiles.add(hit);
          rationale.push(`${hit}: processes queue "${queue}" produced by ${f}`);
        }
      }
    }
  }

  // 2. For each event, find the OTHER side of the wire: listeners and emitters.
  for (const ev of events) {
    const holders = rg(worktree, ev, []);
    for (const h of holders) {
      if (srcChanged.includes(h)) continue;
      if (h.endsWith('.spec.ts')) { if (specs.size < limits.maxSpecs) specs.add(h); continue; }
      if (coupledFiles.size >= limits.maxCoupledFiles) break;
      const text = readIf(path.join(worktree, h));
      const listens = new RegExp(`@OnEvent\\(\\s*${ev.replace(/\./g, '\\.')}`).test(text);
      const emits = new RegExp(`emit\\w*\\([^)]*${ev.replace(/\./g, '\\.')}`).test(text);
      coupledFiles.add(h);
      rationale.push(`${h}: ${listens ? 'LISTENS to' : emits ? 'EMITS' : 'references'} ${ev}`);
    }
  }

  // 3. Specs covering the coupled modules (the tests that would actually catch it).
  for (const f of coupledFiles) {
    for (const s of specsFor(worktree, f)) {
      if (specs.size < limits.maxSpecs) { specs.add(s); rationale.push(`${s}: covers event-coupled ${f}`); }
    }
  }

  return {
    events: [...events], coupledFiles: [...coupledFiles], specs: [...specs],
    rationale: rationale.slice(0, 80),
  };
}
