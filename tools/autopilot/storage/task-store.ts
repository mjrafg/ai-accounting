/**
 * Task state derived from the event log.
 *
 * `task.json` is a cache for humans and for fast `status` reads. It is never
 * the source of truth: `deriveTask` recomputes it from events, and `resume`
 * uses the derived value so a crash between the log append and the cache write
 * cannot desynchronise the pipeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EventStore } from './event-store';
import { AutopilotEvent, Risk, TaskRecord, TaskState } from '../types';

export class TaskStore {
  constructor(private readonly events: EventStore) {}

  private cachePath(taskId: string): string {
    return path.join(this.events.taskDir(taskId), 'task.json');
  }

  exists(taskId: string): boolean {
    return this.events.read(taskId).length > 0;
  }

  nextTaskId(): string {
    const existing = this.events.listTasks();
    let max = 0;
    for (const id of existing) {
      const m = /^TASK-(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `TASK-${String(max + 1).padStart(4, '0')}`;
  }

  /** Rebuilds the current record purely from the immutable log. */
  deriveTask(taskId: string): TaskRecord | null {
    const events = this.events.read(taskId);
    if (events.length === 0) return null;

    const created = events.find((e) => e.type === 'TASK_CREATED');
    if (!created) return null;
    const p = created.payload as Record<string, any>;

    const rec: TaskRecord = {
      taskId,
      title: String(p.title ?? ''),
      description: String(p.description ?? p.title ?? ''),
      risk: (p.risk ?? 'high') as Risk,
      state: 'NEW',
      branch: String(p.branch ?? ''),
      createdAt: created.ts,
      updatedAt: created.ts,
      reviewRounds: 0,
      autoMerge: p.autoMerge === true,
      allowlist: Array.isArray(p.allowlist) ? p.allowlist : [],
    };

    for (const e of events) {
      rec.updatedAt = e.ts;
      switch (e.type) {
        case 'STATE_TRANSITION':
          rec.state = (e.payload as any).to as TaskState;
          break;
        case 'DESIGN_DECISION': {
          const design = (e.payload as any).design;
          // The FINAL design is what binds the allowlist.
          if (design && Array.isArray(design.scopeAllowlist) && (e.payload as any).final) {
            rec.allowlist = design.scopeAllowlist;
          }
          break;
        }
        case 'FINDING':
          if ((e.payload as any).roundStart) rec.reviewRounds += 1;
          break;
        case 'ESCALATION':
          rec.state = 'ESCALATED';
          rec.lastError = String((e.payload as any).reason ?? '');
          break;
        case 'READY_TO_MERGE':
          rec.state = 'READY_TO_MERGE';
          break;
        case 'MERGED':
          rec.state = 'MERGED';
          break;
        default:
          break;
      }
    }
    return rec;
  }

  /** Writes the human-readable cache. Safe to lose. */
  writeCache(rec: TaskRecord): void {
    fs.mkdirSync(this.events.taskDir(rec.taskId), { recursive: true });
    fs.writeFileSync(this.cachePath(rec.taskId), JSON.stringify(rec, null, 2) + '\n', 'utf8');
  }

  /** Events of one type, oldest first. */
  byType(taskId: string, type: AutopilotEvent['type']): AutopilotEvent[] {
    return this.events.read(taskId).filter((e) => e.type === type);
  }

  latest(taskId: string, type: AutopilotEvent['type']): AutopilotEvent | null {
    const all = this.byType(taskId, type);
    return all.length ? all[all.length - 1] : null;
  }
}
