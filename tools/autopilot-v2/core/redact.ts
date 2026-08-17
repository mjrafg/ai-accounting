/**
 * Secret redaction — applied BEFORE anything is persisted or leaves the
 * process. The browser never receives a secret and hides it; the secret never
 * reaches the browser at all. Transcripts on disk are already sanitized.
 */
import * as fs from 'fs';

const PATTERNS: Array<[string, RegExp]> = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{8,}/g],
  ['openai-key', /sk-[A-Za-z0-9]{20,}/g],
  ['github-pat', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['aws-key', /AKIA[0-9A-Z]{16}/g],
  ['bearer', /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi],
  ['authorization-header', /authorization:\s*\S{12,}/gi],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
  ['private-key', /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g],
  ['ssh-key', /ssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/=]{40,}/g],
  ['url-credentials', /([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi],
  ['password-assign', /((?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi],
  ['set-cookie', /((?:ai_cc2?_session|session|sid)=)[a-f0-9]{16,}/gi],
  ['setup-token', /(setup-token\S*\s+)[A-Za-z0-9_-]{12,}/gi],
];

/**
 * Literal secret VALUES read from the machine's env files at boot. Pattern
 * matching cannot know a database password is a password; exact-value matching
 * can. Values are held in memory only, never logged, never compared verbosely.
 */
let knownValues: string[] = [];

export function loadKnownSecrets(files: string[]): number {
  const vals = new Set<string>();
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let v = m[2].replace(/^["']|["']$/g, '');
      // Only values that are actually secret-shaped; short flags and URLs
      // without credentials are not worth masking (and would mangle output).
      const secretKey = /(PASSWORD|SECRET|TOKEN|KEY)$/.test(key) || /_KEY_/.test(key);
      if (secretKey && v.length >= 6) vals.add(v);
    }
  }
  knownValues = [...vals].sort((a, b) => b.length - a.length);
  return knownValues.length;
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const v of knownValues) {
    if (out.includes(v)) out = out.split(v).join('[REDACTED:env]');
  }
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (m, ...groups) => {
      // Patterns with a capture keep the non-secret prefix.
      const g = groups.length > 2 && typeof groups[0] === 'string' && m.startsWith(groups[0])
        ? groups[0] : '';
      return `${g}[REDACTED:${name}]`;
    });
  }
  return out;
}

/** Deep-redacts every string in a JSON-safe payload. */
export function redactPayload<T>(payload: T): T {
  if (typeof payload === 'string') return redact(payload) as unknown as T;
  if (Array.isArray(payload)) return payload.map(redactPayload) as unknown as T;
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) out[k] = redactPayload(v);
    return out as unknown as T;
  }
  return payload;
}

/** True when text still contains something secret-shaped. Used by self-tests. */
export function looksSecret(text: string): boolean {
  for (const v of knownValues) if (text.includes(v)) return true;
  return PATTERNS.some(([, re]) => { re.lastIndex = 0; return re.test(text); });
}
