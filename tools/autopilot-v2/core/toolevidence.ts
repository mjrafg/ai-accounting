/**
 * Machine-recorded tool evidence.
 *
 * An agent saying "I used Graphify" or "I inspected the source" is prose, not
 * evidence — TASK-V2-0005 announced a required Graphify workflow, executed zero
 * commands, and produced a factually wrong blocking finding. Everything here is
 * derived from the raw provider transcript: what the agent actually executed.
 *
 * Claimed-vs-observed disagreement is recorded as TOOL_CLAIM_MISMATCH; observed
 * always wins.
 */

/** A graphify-task JSON receipt, as printed by the wrapper. */
function parseWrapperReceipt(out: string): {
  ok: boolean; graphSourceSha?: string; analyzedSourceSha?: string; graphifyVersion?: string;
} | null {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(out.slice(start, end + 1));
    if (typeof o !== 'object' || o === null) return null;
    if (!('operation' in o) && !('graphifyVersion' in o)) return null;
    return {
      ok: o.ok === true && o.available !== false,
      graphSourceSha: typeof o.graphSourceSha === 'string' ? o.graphSourceSha : undefined,
      analyzedSourceSha: typeof o.analyzedSourceSha === 'string' ? o.analyzedSourceSha : undefined,
      graphifyVersion: typeof o.graphifyVersion === 'string' ? o.graphifyVersion : undefined,
    };
  } catch { return null; }
}

export interface ToolEvidence {
  sourceInspected: boolean;
  /** The agent ran the interface, whether or not it returned a usable graph. */
  graphifyAttempted?: boolean;
  graphifyOperations?: number;
  graphifyVersion?: string | null;
  analyzedSourceSha?: string | null;
  filesInspected: string[];
  commandsExecuted: string[];
  graphifyUsed: boolean;
  graphSourceSha: string | null;
  runtimeVerified: boolean;
  toolCallCount: number;
  claimMismatch: string[];
}

const SOURCE_EXT = /\.(ts|tsx|js|mjs|json|sql|env|yml|yaml)$/i;
/** Commands that constitute actually looking at source. */
const READ_CMD = /(^|[|;&\s])(cat|sed|head|tail|nl|rg|grep|less|awk|find|ls)\b/;
/**
 * A genuine graphify RUN: the binary (optionally path-qualified) immediately
 * followed by one of its subcommands. Deliberately strict — a path mention or
 * a `cat`/`sed` of skill documentation must never count as usage.
 */
const GRAPHIFY_INVOCATION =
  // The leading class must include quote and paren characters: agents run
  // commands as `/bin/bash -lc 'graphify-task query "..."'`, so the character
  // before the binary is usually a quote, not whitespace.
  /(?:^|[|;&\s'"`(])(?:[\w./-]*\/)?graphify(?:-task)?\s+(status|query|affected|path|explain|god-nodes|update|tree|diagnose|merge-graphs|cluster-only)\b/;
/** Commands that constitute mechanically verifying a claim. */
const RUNTIME_CMD = /(^|[|;&\s])(node|npx|jest|tsc|npm|pnpm|python3?)\b|node_modules\/\.bin\//;

function pathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s"'`(])((?:\.\/)?(?:packages|shared|tools|test)\/[\w@./-]+)/g)) {
    const p = m[1].replace(/^\.\//, '');
    if (SOURCE_EXT.test(p)) out.add(p);
  }
  return [...out];
}

/**
 * Parses a raw provider transcript (codex JSONL or claude stream-json) into
 * observed tool usage. Unknown shapes simply yield no evidence — the safe
 * direction, since absent evidence downgrades findings rather than passing them.
 */
export function extractToolEvidence(rawLines: string[]): ToolEvidence {
  const commands: string[] = [];
  const files = new Set<string>();
  let toolCallCount = 0;
  let graphifyObserved = false;
  let graphifyAttempted = false;
  let graphifyOps = 0;
  let graphShaObserved: string | null = null;
  let analyzedShaObserved: string | null = null;
  let graphifyVersionObserved: string | null = null;
  let runtime = false;

  // Counting happens at the call sites: a Bash tool_use is ONE tool call, not
  // two, so this helper only records the command itself.
  const noteCommand = (cmd: string) => {
    if (!cmd) return;
    commands.push(cmd.slice(0, 300));
    // Only a real INVOCATION counts. Merely reading a file whose path contains
    // "graphify" (e.g. .agents/skills/graphify/SKILL.md) is not tool usage —
    // observed in TASK-V2-0010, where it produced a false graphifyUsed=true.
    if (GRAPHIFY_INVOCATION.test(cmd)) {
      graphifyAttempted = true;
      const m = /graphify\/([0-9a-f]{7,40})\//.exec(cmd);
      if (m) graphShaObserved = m[1];
    }
    if (RUNTIME_CMD.test(cmd)) runtime = true;
    if (READ_CMD.test(cmd) || SOURCE_EXT.test(cmd)) for (const p of pathsIn(cmd)) files.add(p);
  };

  for (const line of rawLines) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }

    // codex: item.completed { item: { type: command_execution, command } }
    const it = ev?.item ?? {};
    if (it.type === 'command_execution') {
      toolCallCount += 1;
      const cmd = String(it.command ?? '');
      noteCommand(cmd);
      const out = String(it.aggregated_output ?? it.output ?? '');
      if (out) for (const p of pathsIn(out)) files.add(p);
      // graphify-task emits a structured JSON receipt. When the agent runs in a
      // read-only sandbox the wrapper cannot append to its own log, so this
      // receipt is the machine record of the call. It is the tool's output,
      // never the agent's narration.
      if (out && GRAPHIFY_INVOCATION.test(cmd)) {
        const rec = parseWrapperReceipt(out);
        if (rec) {
          if (rec.ok) graphifyObserved = true;
          graphShaObserved = rec.graphSourceSha ?? graphShaObserved;
          analyzedShaObserved = rec.analyzedSourceSha ?? analyzedShaObserved;
          if (rec.graphifyVersion) graphifyVersionObserved = rec.graphifyVersion;
          if (rec.ok) graphifyOps += 1;
        }
      }
    }
    if (it.type === 'file_read' || it.type === 'file_change') {
      toolCallCount += 1;
      for (const p of pathsIn(JSON.stringify(it))) files.add(p);
    }

    // claude stream-json: assistant messages carrying tool_use blocks
    const content = ev?.message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type !== 'tool_use') continue;
        toolCallCount += 1;
        const input = part.input ?? {};
        const name = String(part.name ?? '');
        if (name === 'Bash') noteCommand(String(input.command ?? ''));
        else {
          const p = String(input.file_path ?? input.path ?? input.pattern ?? '');
          if (p) {
            commands.push(`${name}(${p.slice(0, 160)})`);
            if (SOURCE_EXT.test(p)) files.add(p.replace(/^.*?((?:packages|shared|tools|test)\/)/, '$1'));
          }
          if (name === 'Read' || name === 'Grep' || name === 'Glob') { /* counted above */ }
        }
      }
    }
  }

  return {
    sourceInspected: files.size > 0,
    filesInspected: [...files].slice(0, 60),
    commandsExecuted: commands.slice(0, 40),
    graphifyUsed: graphifyObserved,
    graphifyAttempted,
    graphifyOperations: graphifyOps,
    graphifyVersion: graphifyVersionObserved,
    graphSourceSha: graphShaObserved,
    analyzedSourceSha: analyzedShaObserved,
    runtimeVerified: runtime,
    toolCallCount,
    claimMismatch: [],
  };
}

/**
 * Reconciles what the agent CLAIMED in its structured reply against what was
 * observed. Observed wins; every overclaim is recorded.
 */
export function reconcileClaims(observed: ToolEvidence, claimed: any): ToolEvidence {
  const mismatch: string[] = [];
  const c = claimed && typeof claimed === 'object' ? claimed : {};
  if (c.graphifyUsed === true && !observed.graphifyUsed) {
    mismatch.push('TOOL_CLAIM_MISMATCH: claimed graphifyUsed=true but no graphify invocation was observed');
  }
  if (c.sourceInspected === true && !observed.sourceInspected) {
    mismatch.push('TOOL_CLAIM_MISMATCH: claimed sourceInspected=true but no file inspection was observed');
  }
  if (c.runtimeVerified === true && !observed.runtimeVerified) {
    mismatch.push('TOOL_CLAIM_MISMATCH: claimed runtimeVerified=true but no command execution was observed');
  }
  // Claimed files are additive ONLY if the agent genuinely inspected something.
  const claimedFiles: string[] = Array.isArray(c.filesInspected) ? c.filesInspected.map(String) : [];
  const files = observed.sourceInspected
    ? [...new Set([...observed.filesInspected, ...claimedFiles.filter((f) => SOURCE_EXT.test(f))])].slice(0, 60)
    : observed.filesInspected;
  return { ...observed, filesInspected: files, claimMismatch: mismatch };
}

/**
 * Evidence gate for material findings (IMPORTANT / CRITICAL).
 *
 * A source-code claim made without having looked at the source cannot block on
 * its own; it is downgraded to UNVERIFIED unless some other deterministic
 * evidence (a check the agent actually ran) backs it. This is the architectural
 * answer to the mime-types false finding.
 */
export function findingIsSupported(severity: string, ev: ToolEvidence):
  { supported: boolean; reason: string } {
  if (severity === 'SUGGESTION') return { supported: true, reason: 'suggestions never block' };
  if (ev.sourceInspected) return { supported: true, reason: `source inspected (${ev.filesInspected.length} file(s))` };
  if (ev.runtimeVerified) return { supported: true, reason: 'claim backed by executed command output' };
  return {
    supported: false,
    reason: 'no source inspection and no executed verification: material claim is UNVERIFIED and cannot block alone',
  };
}
