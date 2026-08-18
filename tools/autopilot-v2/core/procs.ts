/**
 * Task-owned process registry.
 *
 * Cancellation has to be able to prove which OS processes belong to which
 * task. Every process V2 starts on a task's behalf — provider CLIs and check
 * commands (tsc, jest, nest build, e2e runner) alike — is spawned into its OWN
 * process group via detached:true and recorded here under its taskId.
 * Termination then signals `kill(-pgid)`, which reaches the command, the shells
 * it spawned, watchers, and anything that re-parented to init.
 *
 * Ownership is structural, never a name pattern: one task's cancel cannot touch
 * another task's work, unrelated system processes, or the control-plane server.
 */
export type ProcKind = 'agent' | 'check';

export interface RunHandle {
  taskId: string;
  runId: string;
  pid: number;
  /** Own process group == pid, because children are spawned detached. */
  pgid: number;
  kind: ProcKind;
  label: string;
  cwd: string;
  startedAt: number;
}

const liveRuns = new Map<number, RunHandle>();

export function registerRun(h: RunHandle): void { if (h.pid > 1) liveRuns.set(h.pid, h); }
export function unregisterRun(pid: number): void { liveRuns.delete(pid); }
export function runsForTask(taskId: string): RunHandle[] {
  return [...liveRuns.values()].filter((h) => h.taskId === taskId);
}
export function allLiveRuns(): RunHandle[] { return [...liveRuns.values()]; }

export function isAlive(pid: number): boolean {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Signal a whole process group. The pgid guard matters: 0 would signal OUR own
 * group (killing the control plane) and 1 would target init.
 */
export function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  if (!pgid || pgid <= 1) return false;
  try { process.kill(-pgid, sig); return true; } catch { /* group already empty */ }
  try { process.kill(pgid, sig); return true; } catch { return false; }
}

export interface TerminationEvidence {
  pid: number; pgid: number; kind: ProcKind; label: string;
  signalled: boolean; forced: boolean; alive: boolean;
}

/**
 * Terminate every process group owned by a task: SIGTERM, a bounded grace
 * period, then SIGKILL for survivors. Returns per-process evidence so the
 * caller can prove the tree is gone rather than assuming it.
 */
export async function terminateTaskRuns(taskId: string, graceMs = 5000): Promise<{
  attempted: TerminationEvidence[]; allGone: boolean;
}> {
  const runs = runsForTask(taskId);
  const attempted: TerminationEvidence[] = runs.map((h) => ({
    pid: h.pid, pgid: h.pgid, kind: h.kind, label: h.label,
    signalled: signalGroup(h.pgid, 'SIGTERM'), forced: false, alive: true,
  }));

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && runs.some((h) => isAlive(h.pid))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const [i, h] of runs.entries()) {
    if (isAlive(h.pid)) {
      attempted[i].forced = signalGroup(h.pgid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
    }
    attempted[i].alive = isAlive(h.pid);
    if (!attempted[i].alive) unregisterRun(h.pid);
  }
  return { attempted, allGone: attempted.every((a) => !a.alive) };
}
