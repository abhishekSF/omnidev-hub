import crypto from 'node:crypto';
import { generatePairingCode, validateToken } from './token.js';

export const SESSION_COOKIE = 'omnidev_session';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionManager {
  private readonly sessions = new Map<string, { expiresAt: number }>();
  private pairingCode: string;
  private pairingExpiresAt: number;

  constructor(
    private readonly token: string,
    pairingTtlMs: number = PAIRING_TTL_MS
  ) {
    this.pairingCode = generatePairingCode();
    this.pairingExpiresAt = Date.now() + pairingTtlMs;
  }

  public getPairingCode(): string {
    return this.pairingCode;
  }

  public pairingIsExpired(): boolean {
    return Date.now() > this.pairingExpiresAt;
  }

  public createSession(secret: string): string | null {
    if (!secret || typeof secret !== 'string') return null;
    const trimmed = secret.trim();
    const pairingOk =
      !this.pairingIsExpired() &&
      validateToken(trimmed.toUpperCase(), this.pairingCode);

    const tokenOk = validateToken(trimmed, this.token);
    if (!pairingOk && !tokenOk) return null;

    const id = crypto.randomBytes(24).toString('hex');
    this.sessions.set(id, { expiresAt: Date.now() + SESSION_TTL_MS });
    return id;
  }

  public isValidSession(id: string | null | undefined): boolean {
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function sessionCookieHeader(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}
