import { describe, expect, it } from 'vitest';
import { safeAuthReturnPath } from '@/features/auth/return-path';

describe('safe password-login return paths', () => {
  it('preserves normal internal admin and account targets', () => {
    expect(safeAuthReturnPath('/admin')).toBe('/admin');
    expect(safeAuthReturnPath('/account?tab=history')).toBe('/account?tab=history');
  });
  it('does not redirect credentials to absolute, protocol-relative, backslash, or control-character targets', () => {
    for (const value of [undefined, '', 'https://evil.example', '//evil.example', '/\\evil.example', '/admin\nheader']) {
      expect(safeAuthReturnPath(value)).toBe('/account');
    }
  });
});
