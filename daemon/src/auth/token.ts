import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Validates bearer/pairing secrets using UTF-8 byte length comparison
 * before timingSafeEqual to avoid ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH.
 */
export function validateToken(tokenStr: string | null | undefined, expectedToken: string): boolean {
  if (!tokenStr || typeof tokenStr !== 'string' || !expectedToken) return false;
  try {
    const tokenBuf = Buffer.from(tokenStr, 'utf8');
    const authBuf = Buffer.from(expectedToken, 'utf8');
    if (tokenBuf.length !== authBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(tokenBuf, authBuf);
  } catch {
    return false;
  }
}

export function resolveDataDir(override?: string): string {
  return override || process.env.OMNIDEV_HOME || path.join(process.env.HOME || '/tmp', '.omnidev');
}

export function loadOrCreateToken(dataDir: string, envToken?: string): { token: string; tokenPath: string; firstCreated: boolean } {
  if (envToken && envToken.length > 0) {
    return { token: envToken, tokenPath: path.join(dataDir, 'token'), firstCreated: false };
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dataDir, 'token');
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim();
    if (existing.length > 0) {
      return { token: existing, tokenPath, firstCreated: false };
    }
  }

  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return { token, tokenPath, firstCreated: true };
}

export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}
