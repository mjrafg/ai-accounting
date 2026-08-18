/**
 * V2 persistence. Everything lives OUTSIDE every git worktree:
 *
 *   STATE/tasks/<id>/task.json          derived cache (rebuildable)
 *   STATE/tasks/<id>/events.jsonl       append-only, hash-chained
 *   STATE/streams/<id>.jsonl            sanitized live stream, monotonic ids
 *   STATE/transcripts/<id>/<agent>.jsonl per-agent sanitized transcripts
 *   STATE/artifacts/<id>/               raw provider envelopes, 0600, debug only
 *   STATE/locks/                        global locks (stage -1, merge, deploy)
 *
 * Routine task execution never dirties a source tree.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { V2Event, EventType, TaskRecord, TaskState, DesignRevision, Finding } from './types';
import { redact, redactPayload } from './redact';

export const STATE_ROOT = process.env.AI_V2_STATE ?? '/srv/ai-accounting/state-v2';

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ensure(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Append-only events
// ---------------------------------------------------------------------------

export class EventStore {
  constructor(readonly root: string = STATE_ROOT) {}

  taskDir(id: string): string { return path.join(this.root, 'tasks', id); }
  eventsPath(id: string): string { return path.join(this.taskDir(id), 'events.jsonl'); }

  read(taskId: string): V2Event[] {
    const p = this.eventsPath(taskId);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  listTasks(): string[] {
    const dir = path.join(this.root, 'tasks');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((d) => fs.existsSync(this.eventsPath(d))).sort();
  }

  append(input: {
    taskId: string; type: EventType; payload: Record<string, unknown>;
    agent?: V2Event['agent']; phase?: string; subPhase?: string; attempt?: number;
  }): V2Event {
    const existing = this.read(input.taskId);
    const body = {
      taskId: input.taskId,
      seq: existing.length + 1,
      ts: new Date().toISOString(),
      type: input.type,
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.subPhase ? { subPhase: input.subPhase } : {}),
      ...(input.attempt ? { attempt: input.attempt } : {}),
      payload: redactPayload(input.payload),
    };
    const ev: V2Event = { id: `EV2-${sha256(JSON.stringify(body)).slice(0, 16)}`, ...body } as V2Event;
    ensure(this.taskDir(input.taskId));
    fs.appendFileSync(this.eventsPath(input.taskId), JSON.stringify(ev) + '\n');
    return ev;
  }

  verify(taskId: string): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    this.read(taskId).forEach((e, i) => {
      if (e.seq !== i + 1) problems.push(`seq gap at ${i + 1}`);
      const { id, ...body } = e as any;
      if (`EV2-${sha256(JSON.stringify(body)).slice(0, 16)}` !== id) problems.push(`event ${i + 1} modified after write`);
    });
    return { ok: problems.length === 0, problems };
  }
}

// ---------------------------------------------------------------------------
// Live stream: sanitized, durable, replayable
// ---------------------------------------------------------------------------

export interface StreamChunk {
  id: number;                 // monotonic per task — the SSE replay cursor
  ts: string;
  agent: string;              // claude | codex | claude-code | system
  kind: string;               // text | thinking | tool | event | lifecycle | error
  text: string;
  phase?: string;
}

/**
 * One durable stream log per task. SSE serves from this file: live appends are
 * broadcast, and a reconnect with Last-Event-ID replays everything after the
 * cursor from disk — history and live continue seamlessly, no duplicates,
 * because the id is assigned exactly once at append time.
 */
export class StreamLog extends EventEmitter {
  private counters = new Map<string, number>();

  constructor(readonly root: string = STATE_ROOT) { super(); this.setMaxListeners(200); }

  path(taskId: string): string { return path.join(this.root, 'streams', `${taskId}.jsonl`); }
  transcriptPath(taskId: string, agent: string): string {
    return path.join(this.root, 'transcripts', taskId, `${agent}.jsonl`);
  }

  private nextId(taskId: string): number {
    if (!this.counters.has(taskId)) {
      const p = this.path(taskId);
      let last = 0;
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
        const tail = lines[lines.length - 1];
        if (tail) try { last = JSON.parse(tail).id ?? 0; } catch { last = lines.length; }
      }
      this.counters.set(taskId, last);
    }
    const n = this.counters.get(taskId)! + 1;
    this.counters.set(taskId, n);
    return n;
  }

  append(taskId: string, agent: string, kind: string, text: string, phase?: string): StreamChunk {
    const clean = redact(text);
    const chunk: StreamChunk = {
      id: this.nextId(taskId), ts: new Date().toISOString(), agent, kind, text: clean,
      ...(phase ? { phase } : {}),
    };
    ensure(path.dirname(this.path(taskId)));
    fs.appendFileSync(this.path(taskId), JSON.stringify(chunk) + '\n');
    if (agent !== 'system') {
      ensure(path.dirname(this.transcriptPath(taskId, agent)));
      fs.appendFileSync(this.transcriptPath(taskId, agent), JSON.stringify(chunk) + '\n');
    }
    this.emit(`chunk:${taskId}`, chunk);
    this.emit('chunk', taskId, chunk);
    return chunk;
  }

  /** Replay everything after `afterId` from disk. */
  replay(taskId: string, afterId: number, limit = 5000): StreamChunk[] {
    const p = this.path(taskId);
    if (!fs.existsSync(p)) return [];
    const out: StreamChunk[] = [];
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line) continue;
      let c: StreamChunk;
      try { c = JSON.parse(line); } catch { continue; }
      if (c.id > afterId) { out.push(c); if (out.length >= limit) break; }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Raw artifacts (debug only, never served)
// ---------------------------------------------------------------------------

export function writeRawArtifact(taskId: string, name: string, content: string): string {
  const dir = ensure(path.join(STATE_ROOT, 'artifacts', taskId));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

// ---------------------------------------------------------------------------
// Task projection — derived from events, never a second authority
// ---------------------------------------------------------------------------

export function deriveTask(events: EventStore, taskId: string): TaskRecord | null {
  const evs = events.read(taskId);
  if (!evs.length) return null;
  const created = evs.find((e) => e.type === 'TASK_CREATED');
  if (!created) return null;
  const p = created.payload as any;
  const rec: TaskRecord = {
    taskId,
    title: String(p.title ?? ''),
    description: String(p.description ?? p.title ?? ''),
    risk: (p.risk ?? 'high') as any,
    state: 'NEW',
    phase: '', subPhase: '',
    branch: String(p.branch ?? ''),
    baseSha: String(p.baseSha ?? ''),
    headSha: String(p.baseSha ?? ''),
    createdAt: created.ts,
    updatedAt: evs[evs.length - 1].ts,
    worktree: String(p.worktree ?? ''),
    awaitingHuman: null,
  };
  // Cancellation is ABSORBING: once the owner cancels, no later event may move
  // the task back into a live or escalated state. Without this a late
  // AGENT_FAILED from the killed process resurrected TASK-V2-0007 into
  // ESCALATED four minutes after it was cancelled.
  let cancelRequested = false;
  for (const e of evs) {
    if (e.type === 'CANCEL_REQUESTED') { cancelRequested = true; rec.state = 'CANCELLING'; rec.cancelledAt = e.ts; continue; }
    // Only an explicit owner recovery lifts the absorbing cancellation.
    if (e.type === 'TASK_RECOVERED') { cancelRequested = false; rec.cancelledAt = undefined; continue; }
    if (e.type === 'TASK_CANCELLED') { cancelRequested = true; rec.state = 'CANCELLED'; rec.cancelledAt = rec.cancelledAt ?? e.ts; continue; }
    if (e.type === 'STATE_CHANGED') {
      const to = (e.payload as any).to as TaskState;
      // After cancellation only the cancellation states themselves are allowed.
      if (cancelRequested && to !== 'CANCELLED' && to !== 'CANCELLING') continue;
      rec.state = to;
      rec.phase = e.phase ?? rec.phase;
      rec.subPhase = e.subPhase ?? '';
      if ((e.payload as any).awaiting) rec.awaitingHuman = (e.payload as any).awaiting;
      if (rec.state !== 'AWAITING_HUMAN') rec.awaitingHuman = null;
      continue;
    }
    if (e.type === 'CODE_CHANGE' && (e.payload as any).headSha && !cancelRequested) rec.headSha = (e.payload as any).headSha;
    if (e.type === 'NOTE' && (e.payload as any).lastError && !cancelRequested) rec.lastError = String((e.payload as any).lastError);
  }
  return rec;
}

export function currentDesign(events: EventStore, taskId: string): DesignRevision | null {
  const revs = events.read(taskId).filter((e) => e.type === 'DESIGN_REVISION');
  if (!revs.length) return null;
  return (revs[revs.length - 1].payload as any).design as DesignRevision;
}

export function allFindings(events: EventStore, taskId: string): Finding[] {
  const map = new Map<string, Finding>();
  for (const e of events.read(taskId)) {
    if (e.type === 'FINDING') {
      for (const f of ((e.payload as any).findings ?? []) as Finding[]) {
        map.set(f.findingId, { ...f, status: f.status ?? 'UNRESOLVED' });
      }
    }
    if (e.type === 'ADJUDICATION') {
      const p = e.payload as any;
      const f = map.get(p.findingId);
      if (f) { f.status = p.status; f.decisionSource = p.decisionSource ?? 'agent'; f.evidence = p.evidence ?? f.evidence; }
    }
  }
  return [...map.values()];
}
