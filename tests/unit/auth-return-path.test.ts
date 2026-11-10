import { afterEach, describe, expect, it, vi } from 'vitest';
import { authCallbackUrl, safeAuthReturnPath } from '@/features/auth/return-path';

afterEach(() => vi.unstubAllEnvs());

describe('safe password-login return paths', () => {
  it('preserves normal internal admin and account targets', () => {
    expect(safeAuthReturnPath('/admin')).toBe('/admin');
    expect(safeAuthReturnPath('/account?tab=history')).toBe('/account?tab=history');
  });
  it('does not redirect credentials to absolute, protocol-relative, backslash, or control-character targets', () => {
    for (const value of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/admin\nheader',
      '/a/..//evil.example', '/%2e//evil.example', '/a/%2e%2e//evil.example', '/signin', '/signup', '/auth/callback']) {
      expect(safeAuthReturnPath(value)).toBe('/account');
    }
  });
  it('preserves ordinary paths, query strings, and fragments after normalization', () => {
    expect(safeAuthReturnPath('/account/../watch/movie?episode=1#player')).toBe('/watch/movie?episode=1#player');
  });
});

describe('canonical email callback URLs', () => {
  it('uses only the configured HTTPS origin with an internal return path', () => {
    const callback = authCallbackUrl('https://lumora.example.test', '/account/history');
    expect(callback?.href).toBe('https://lumora.example.test/auth/callback?next=%2Faccount%2Fhistory');
  });
  it.each(['', '//example.test', 'http://example.test', 'ftp://example.test', 'https://name:password@example.test',
    'https://example.test/path', 'https://example.test?origin=evil', 'https://example.test#fragment'])('rejects an unsafe or non-origin setting: %s', (origin) => {
    expect(authCallbackUrl(origin)).toBeNull();
  });
  it('permits loopback HTTP in development but never sends production confirmation to a loopback default', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(authCallbackUrl('http://localhost:3000')?.origin).toBe('http://localhost:3000');
    vi.stubEnv('NODE_ENV', 'production');
    expect(authCallbackUrl('http://localhost:3000')).toBeNull();
    expect(authCallbackUrl('https://127.0.0.1')).toBeNull();
  });
});
