/**
 * Claude as architect and adjudicator.
 *
 * Discovered on this machine: the `claude` binary (Claude Code 2.1.233) exposes
 * a non-interactive mode via `-p/--print` with `--output-format json`. The
 * advisor runs with no write tools so it cannot touch production code -- its
 * only job is to produce a design or adjudicate findings.
 */
import { AgentAdapter, AgentResult, AgentTask } from '../types';
import { TransportSpec, runTransport, which, fixturesAllowed } from './transport';

export const CLAUDE_BIN_ENV = 'AI_CLAUDE_BIN';

export function claudeArgv(bin: string, readOnly: boolean): string[] {
  const tools = readOnly ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];
  return [
    bin,
    '-p',
    '{{PROMPT}}',
    '--output-format',
    'json',
    '--permission-mode',
    readOnly ? 'manual' : 'acceptEdits',
    '--allowed-tools',
    tools.join(' '),
  ];
}

export class ClaudeAdvisorAdapter implements AgentAdapter {
  readonly name = 'claude-advisor';
  readonly provider = 'anthropic';

  constructor(private readonly repoRoot: string) {}

  private spec(): TransportSpec {
    const bin = process.env[CLAUDE_BIN_ENV] ?? which('claude');
    if (bin) {
      return { kind: 'exec', argv: claudeArgv(bin, true), provider: this.provider };
    }
    return { kind: 'fixture', provider: this.provider };
  }

  async available(): Promise<{ ok: boolean; reason?: string; mechanism?: string }> {
    const bin = process.env[CLAUDE_BIN_ENV] ?? which('claude');
    if (bin) {
      return { ok: true, mechanism: `exec ${bin} -p --output-format json (read-only tools)` };
    }
    if (fixturesAllowed()) {
      return { ok: true, mechanism: 'fixture replay (SIMULATED — not a live model)' };
    }
    return {
      ok: false,
      reason:
        'the `claude` executable is not reachable from this process. It is installed on the macOS host ' +
        '(/Users/mjrafg/.local/bin/claude, Mach-O arm64) but the repo toolchain runs inside the bc-node ' +
        'Linux container, which has no node on the host side to run the CLI from. Set AI_CLAUDE_BIN to a ' +
        'reachable executable, or run the orchestrator where `claude` exists.',
    };
  }

  async run(input: AgentTask): Promise<AgentResult> {
    return runTransport(this.spec(), input);
  }
}
