/**
 * TOTP (RFC 6238) — dependency-free MFA for the sensitive approval paths.
 * Enrollment is owner-initiated from the System page; until enrolled the UI
 * shows "MFA NOT CONFIGURED" and approvals proceed on session+CSRF alone.
 * Once enrolled, merge/deploy/human-decision approvals REQUIRE a valid code.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';

const MFA_FILE = process.env.AI_V2_MFA_FILE ?? '/etc/ai-accounting/owner-mfa.json';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function totp(secretB32: string, timeStep = 30, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / timeStep);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotp(secretB32: string, code: string, window = 1): boolean {
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(totp(secretB32, 30, Date.now() + w * 30_000)), Buffer.from(c))) return true;
  }
  return false;
}

interface MfaRecord { secret: string; enrolledAt?: string; pending?: boolean; }

function read(): MfaRecord | null {
  try { return JSON.parse(fs.readFileSync(MFA_FILE, 'utf8')); } catch { return null; }
}

export function mfaStatus(): { enrolled: boolean; pending: boolean } {
  const r = read();
  return { enrolled: Boolean(r && !r.pending), pending: Boolean(r?.pending) };
}

/** Starts enrollment: generates a secret, returns the otpauth URL. Pending until verified. */
export function mfaBeginEnroll(account = 'owner@ai.agent24.io'): { otpauth: string; secret: string } {
  const secret = base32Encode(crypto.randomBytes(20));
  fs.writeFileSync(MFA_FILE, JSON.stringify({ secret, pending: true }), { mode: 0o600 });
  return {
    otpauth: `otpauth://totp/AI%20Control%20Center:${encodeURIComponent(account)}?secret=${secret}&issuer=AI%20Control%20Center`,
    secret,
  };
}

export function mfaConfirmEnroll(code: string): boolean {
  const r = read();
  if (!r?.pending) return false;
  if (!verifyTotp(r.secret, code)) return false;
  fs.writeFileSync(MFA_FILE, JSON.stringify({ secret: r.secret, enrolledAt: new Date().toISOString() }), { mode: 0o600 });
  return true;
}

/** Gate for sensitive approvals: passes when not enrolled; verifies when enrolled. */
export function mfaCheck(code: string | undefined): { ok: boolean; reason?: string } {
  const st = mfaStatus();
  if (!st.enrolled) return { ok: true, reason: 'MFA NOT CONFIGURED' };
  const r = read();
  if (!r) return { ok: false, reason: 'mfa record unreadable' };
  return verifyTotp(r.secret, code ?? '') ? { ok: true } : { ok: false, reason: 'invalid MFA code' };
}
