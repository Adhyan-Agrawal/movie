import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type SubtitleTrack = {
  id: string;
  kind: 'subtitles' | 'captions';
  label: string;
  language: string;
  url: string;
};

export type NormalizedSubtitle = Omit<SubtitleTrack, 'url'> & { upstreamUrl: string };

type TokenPayload = { expiresAt: number; url: string };

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_TRACKS_PER_LANGUAGE = 3;
const MAX_TRACKS = 50;

function compactLabel(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3).trimEnd()}...`;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname === 'sub.wyzie.io' ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeSubtitleCatalog(input: unknown): NormalizedSubtitle[] {
  if (!Array.isArray(input)) return [];

  const tracks: NormalizedSubtitle[] = [];
  const perLanguage = new Map<string, number>();
  const dedupe = new Set<string>();
  const ids = new Set<string>();

  for (const candidate of input) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    const id = typeof value.id === 'string' ? value.id : '';
    const upstreamUrl = httpsUrl(value.url);
    const language = typeof value.language === 'string' ? value.language.trim().toLowerCase() : '';
    if (!id.trim() || id.length > 512 || ids.has(id) || !upstreamUrl
      || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(language)) continue;

    const hearingImpaired = value.isHearingImpaired === true;
    const release = compactLabel(value.release ?? value.fileName, 48);
    const dedupeKey = `${language}:${hearingImpaired ? 'hi' : 'standard'}:${release.toLowerCase()}`;
    if (dedupe.has(dedupeKey) || (perLanguage.get(language) ?? 0) >= MAX_TRACKS_PER_LANGUAGE) continue;

    const display = compactLabel(value.display, 32) || language.toUpperCase();
    const label = `${display}${hearingImpaired ? ' SDH' : ''}${release ? ` / ${release}` : ''}`;
    tracks.push({
      id,
      label,
      language,
      kind: hearingImpaired ? 'captions' : 'subtitles',
      upstreamUrl,
    });
    ids.add(id);
    dedupe.add(dedupeKey);
    perLanguage.set(language, (perLanguage.get(language) ?? 0) + 1);
    if (tracks.length === MAX_TRACKS) break;
  }

  return tracks;
}

function tokenKeys(secret: string): { encryption: Buffer; signing: Buffer } {
  const master = createHmac('sha256', secret).update('lumora:wyzie-subtitles:v1').digest();
  return {
    encryption: createHmac('sha256', master).update('encryption').digest(),
    signing: createHmac('sha256', master).update('signing').digest(),
  };
}

function signature(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

export function createSubtitleToken(url: string, secret: string, now = Date.now()): string {
  const safeUrl = httpsUrl(url);
  if (!safeUrl) throw new Error('Invalid subtitle URL.');

  const keys = tokenKeys(secret);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.encryption, nonce);
  const plaintext = Buffer.from(JSON.stringify({ url: safeUrl, expiresAt: now + TOKEN_TTL_MS } satisfies TokenPayload));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const body = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  const signed = `${TOKEN_VERSION}.${body}`;
  return `${signed}.${signature(signed, keys.signing)}`;
}

export function readSubtitleToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const [version, body, receivedSignature, extra] = token.split('.');
  if (version !== TOKEN_VERSION || !body || !receivedSignature || extra) return null;

  const keys = tokenKeys(secret);
  const expected = Buffer.from(signature(`${version}.${body}`, keys.signing));
  const received = Buffer.from(receivedSignature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const encrypted = Buffer.from(body, 'base64url');
    if (encrypted.length <= 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', keys.encryption, encrypted.subarray(0, 12));
    decipher.setAuthTag(encrypted.subarray(12, 28));
    const decoded = Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8');
    const payload = JSON.parse(decoded) as Partial<TokenPayload>;
    const url = httpsUrl(payload.url);
    if (!url || typeof payload.expiresAt !== 'number' || !Number.isSafeInteger(payload.expiresAt)
      || payload.expiresAt <= now || payload.expiresAt > now + TOKEN_TTL_MS) return null;
    return { url, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

export function tracksWithTokens(
  subtitles: NormalizedSubtitle[], secret: string, now = Date.now(),
): SubtitleTrack[] {
  return subtitles.map(({ upstreamUrl, ...track }) => ({
    ...track,
    url: `/api/subtitles?token=${encodeURIComponent(createSubtitleToken(upstreamUrl, secret, now))}`,
  }));
}
