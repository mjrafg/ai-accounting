/**
 * Codex as the independent reviewer.
 *
 * Reviewer-provider independence is a hard policy: if this adapter cannot run,
 * the task ESCALATES. There is deliberately no code path here that substitutes
 * Claude, because a review by the same provider that wrote the code is not an
 * independent review no matter how it is prompted.
 *
 * Discovery on this machine: no `codex` executable exists on the host or in the
 * bc-node container. The exec transport is built against the documented
 * non-interactive entry point (`codex exec <prompt>`), so it activates as soon
 * as the binary is installed or AI_CODEX_BIN points at one.
 */
import { AgentAdapter, AgentResult, AgentTask } from '../types';
import { TransportSpec, runTransport, which, fixturesAllowed } from './transport';

export const CODEX_BIN_ENV = 'AI_CODEX_BIN';

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  readonly provider = 'openai';

  constructor(private readonly repoRoot: string) {}

  private resolveBin(): string | null {
    return process.env[CODEX_BIN_ENV] ?? which('codex');
  }

  private spec(): TransportSpec {
    const bin = this.resolveBin();
    if (bin) {
      // Discovered from `codex exec --help` on this host (codex-cli 0.147.0):
      // non-interactive run, JSON event stream, explicit working directory, and
      // a read-only sandbox because a reviewer must never edit the code.
      return {
        kind: 'exec',
        argv: [
          bin, 'exec',
          '--json',
          '--skip-git-repo-check',
          '--sandbox', 'read-only',
          '-C', this.repoRoot,
          '{{PROMPT}}',
        ],
        provider: this.provider,
      };
    }
    return { kind: 'fixture', provider: this.provider };
  }

  async available(): Promise<{ ok: boolean; reason?: string; mechanism?: string }> {
    const bin = this.resolveBin();
    if (bin) {
      return { ok: true, mechanism: `exec ${bin} exec --json --sandbox read-only -C <repo>` };
    }
    if (fixturesAllowed()) {
      return { ok: true, mechanism: 'fixture replay (SIMULATED — does NOT satisfy reviewer independence)' };
    }
    return {
      ok: false,
      reason:
        'no `codex` executable found on the host or in the bc-node container. Reviewer-provider ' +
        'independence is a hard policy, so the orchestrator will ESCALATE rather than review with ' +
        'Claude. Install the Codex CLI or set AI_CODEX_BIN.',
    };
  }

  async run(input: AgentTask): Promise<AgentResult> {
    return runTransport(this.spec(), input);
  }
}

/**
 * True when the reviewer is a real, independent provider. A simulated reviewer
 * may exercise the pipeline but can never satisfy this predicate, which is what
 * final acceptance checks before emitting READY_TO_MERGE.
 */
export function reviewerIsIndependent(reviewer: AgentResult, builderProvider: string): boolean {
  return !reviewer.simulated && reviewer.provider !== builderProvider;
}
