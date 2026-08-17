/**
 * Claude Code as builder.
 *
 * Same binary as the advisor but with write tools enabled and a different
 * contract: it receives only the finalized design and must either implement
 * inside the allowlist or return SCOPE_EXPANSION_REQUIRED. It never decides on
 * its own to widen scope -- the orchestrator routes that back through design.
 */
import { AgentAdapter, AgentResult, AgentTask } from '../types';
import { TransportSpec, runTransport, which, fixturesAllowed } from './transport';
import { CLAUDE_BIN_ENV, claudeArgv } from './claude-advisor';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly provider = 'anthropic';

  constructor(private readonly repoRoot: string) {}

  private spec(): TransportSpec {
    const bin = process.env[CLAUDE_BIN_ENV] ?? which('claude');
    if (bin) {
      return { kind: 'exec', argv: claudeArgv(bin, false), provider: this.provider };
    }
    return { kind: 'fixture', provider: this.provider };
  }

  async available(): Promise<{ ok: boolean; reason?: string; mechanism?: string }> {
    const bin = process.env[CLAUDE_BIN_ENV] ?? which('claude');
    if (bin) {
      return { ok: true, mechanism: `exec ${bin} -p --output-format json (edit tools enabled)` };
    }
    if (fixturesAllowed()) {
      return { ok: true, mechanism: 'fixture replay (SIMULATED — not a live model)' };
    }
    return {
      ok: false,
      reason: 'the `claude` executable is not on PATH for this process (see claude-advisor for detail)',
    };
  }

  async run(input: AgentTask): Promise<AgentResult> {
    return runTransport(this.spec(), input);
  }
}
