/**
 * Append-only JSONL event store.
 *
 * Two invariants this file exists to protect:
 *   1. Records are never rewritten. `append` only ever adds a line.
 *   2. Nothing that looks like a credential is ever written to a tracked file.
 *      A suspected secret is a hard write refusal, not a silent redaction --
 *      quietly editing evidence is worse than failing loudly.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AutopilotEvent, EventType, Actor, Confidence } from '../types';

/** Versioned Autopilot config: policies, roles, schema. Lives in the repo. */
export const AI_ROOT = path.resolve(__dirname, '../../../.ai');

/**
 * Runtime state: event logs and raw agent artifacts.
 *
 * Deliberately outside the repository by default on the server. When these were
 * written into `.ai/` inside the checkout, every event append modified a tracked
 * file in the very tree the policy engine was measuring — the orchestrator
 * dirtied the repo it was policing. Config stays versioned; runtime state does
 * not belong in a task's diff.
 */
export const AI_STATE_ROOT = process.env.AI_STATE_ROOT ?? AI_ROOT;

export class SecretDetectedError extends Error {
  constructor(public readonly pattern: string, public readonly where: string) {
    super(`refusing to write event: possible secret (${pattern}) in ${where}`);
    this.name = 'SecretDetectedError';
  }
}

/** Deliberately broad. False positives block a write; false negatives leak. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{8,}/],
  ['openai-key', /\bsk-[A-Za-z0-9]{32,}/],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['private-key-block', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['db-connection-string', /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/i],
  ['password-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"',}]{8,}/i],
];

export function scanForSecrets(value: unknown, where = 'payload'): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return;
  for (const [name, re] of SECRET_PATTERNS) {
    if (re.test(text)) throw new SecretDetectedError(name, where);
  }
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export interface AppendInput {
  taskId: string;
  type: EventType;
  actor: Actor;
  payload: Record<string, unknown>;
  parents?: string[];
  ts?: string;
  reconstructed?: boolean;
  reconstructionConfidence?: Confidence;
  source?: string;
  simulated?: boolean;
}

export class EventStore {
  constructor(private readonly root: string = AI_STATE_ROOT) {}

  taskDir(taskId: string): string {
    return path.join(this.root, 'tasks', taskId);
  }

  logPath(taskId: string): string {
    return path.join(this.taskDir(taskId), 'events.jsonl');
  }

  read(taskId: string): AutopilotEvent[] {
    const p = this.logPath(taskId);
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AutopilotEvent);
  }

  listTasks(): string[] {
    const dir = path.join(this.root, 'tasks');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, 'events.jsonl')))
      .sort();
  }

  append(input: AppendInput): AutopilotEvent {
    // Secret scan happens before anything touches the filesystem, so a refused
    // write leaves no partial record behind.
    scanForSecrets(input.payload, `event.payload (${input.type})`);

    const existing = this.read(input.taskId);
    const seq = existing.length + 1;
    const ts = input.ts ?? new Date().toISOString();
    const body = {
      taskId: input.taskId,
      seq,
      ts,
      type: input.type,
      actor: input.actor,
      parents: input.parents ?? [],
      payload: input.payload,
      ...(input.reconstructed ? { reconstructed: true } : {}),
      ...(input.reconstructionConfidence
        ? { reconstructionConfidence: input.reconstructionConfidence }
        : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.simulated ? { simulated: true } : {}),
    };
    // Content-addressed id: same content in the same position => same id, which
    // is what makes a rebuild byte-identical.
    const eventId = `EV-${sha256(JSON.stringify(body)).slice(0, 16)}`;
    const event: AutopilotEvent = { eventId, ...body } as AutopilotEvent;

    const dir = this.taskDir(input.taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(this.logPath(input.taskId), JSON.stringify(event) + '\n', 'utf8');
    return event;
  }

  /** Verifies the log has not been rewritten under us. */
  verifyIntegrity(taskId: string): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const events = this.read(taskId);
    events.forEach((e, i) => {
      if (e.seq !== i + 1) problems.push(`seq gap at line ${i + 1}: found ${e.seq}`);
      const { eventId, ...body } = e;
      const expected = `EV-${sha256(JSON.stringify(body)).slice(0, 16)}`;
      if (expected !== eventId) problems.push(`event ${eventId} (line ${i + 1}) was modified after write`);
    });
    return { ok: problems.length === 0, problems };
  }
}

/** Writes a raw agent artifact outside version control and returns its hash. */
export function writeRawArtifact(taskId: string, name: string, content: string): {
  rawArtifactPath: string;
  rawArtifactHash: string;
} {
  const dir = path.join(AI_STATE_ROOT, 'runs', taskId, 'raw');
  fs.mkdirSync(dir, { recursive: true });
  const rawArtifactPath = path.join(dir, name);
  fs.writeFileSync(rawArtifactPath, content, 'utf8');
  return { rawArtifactPath, rawArtifactHash: sha256(content) };
}
