import { describe, expect, it } from 'vitest';
// @ts-expect-error The production deploy workflow intentionally remains executable ESM JavaScript.
import { deploymentConfig, deploymentSteps, parseDevVars, validateAllowedOrigins, validateSecret } from '../../scripts/deploy.mjs';

describe('Watch Party deploy workflow', () => {
  it('parses local bindings without duplicate or malformed names', () => {
    expect(parseDevVars("WATCH_PARTY_SECRET='secret value'\nALLOWED_ORIGINS=https://app.example.com"))
      .toEqual({ WATCH_PARTY_SECRET: 'secret value', ALLOWED_ORIGINS: 'https://app.example.com' });
    expect(() => parseDevVars('BAD-NAME=value')).toThrow('Invalid variable name');
    expect(() => parseDevVars('A=1\nA=2')).toThrow('Duplicate A');
  });

  it('requires a long secret and unique public HTTPS allowlist', () => {
    expect(validateSecret('x'.repeat(32))).toBe('x'.repeat(32));
    expect(() => validateSecret('short')).toThrow('at least 32');
    expect(validateAllowedOrigins('https://app.example.org,https://m.example.org'))
      .toBe('https://app.example.org,https://m.example.org');
    expect(() => validateAllowedOrigins('http://app.example.org')).toThrow('public HTTPS origin');
    expect(() => validateAllowedOrigins('https://app.example.org,https://app.example.org')).toThrow('unique');
  });

  it('keeps secrets out of command arguments', () => {
    const config = deploymentConfig({
      WATCH_PARTY_SECRET: 's'.repeat(40),
      ALLOWED_ORIGINS: 'https://app.example.org',
      WATCH_PARTY_PUBLIC_URL: 'https://watch.example.org',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'token',
    });
    expect(config).toMatchObject({ allowedOrigins: 'https://app.example.org', publicUrl: 'https://watch.example.org' });
    const serialized = JSON.stringify(deploymentSteps(config.allowedOrigins, 'C:/temp/secrets.json'));
    expect(serialized).not.toContain(config.secret);
    expect(serialized).toContain('--secrets-file');
  });
});
