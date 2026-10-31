import { describe, expect, it } from 'vitest';
import {
  deploymentConfig,
  deploymentSteps,
  parseDevVars,
  validateOrigin,
  validatePublicUrl,
  validateSecret,
} from '../scripts/deploy.mjs';

const SECRET = 'worker-deployment-secret-at-least-32-characters';

describe('VidNest Worker deployment validation', () => {
  it('accepts only a canonical public HTTPS application origin', () => {
    expect(validateOrigin('https://app.lumora.example.org')).toBe('https://app.lumora.example.org');
    expect(validateOrigin('https://app.lumora.example.org:8443/')).toBe('https://app.lumora.example.org:8443');
    for (const value of [
      'http://app.lumora.example.org',
      'https://user:password@app.lumora.example.org',
      'https://app.lumora.example.org/path',
      'https://app.lumora.example.org?query=1',
      'https://app.lumora.example.org?',
      'https://app.lumora.example.org#fragment',
      'https://app.lumora.example.org#',
      'https://localhost',
      'https://127.0.0.1',
      'https://[::1]',
      'https://app.invalid',
    ]) expect(() => validateOrigin(value)).toThrow(/public HTTPS origin/);
  });

  it('requires the canonical public CDN media endpoint', () => {
    expect(validatePublicUrl('https://lumora-vidnest-cdn.example.workers.dev/media'))
      .toBe('https://lumora-vidnest-cdn.example.workers.dev/media');
    for (const value of [
      'http://lumora-vidnest-cdn.example.workers.dev/media',
      'https://lumora-vidnest-cdn.example.workers.dev/',
      'https://lumora-vidnest-cdn.example.workers.dev/media?token=unsafe',
      'https://localhost/media',
    ]) expect(() => validatePublicUrl(value)).toThrow(/public HTTPS URL/);
  });

  it('requires a non-multiline secret of at least 32 characters', () => {
    expect(validateSecret(SECRET)).toBe(SECRET);
    expect(() => validateSecret('too-short')).toThrow(/at least 32/);
    expect(() => validateSecret(`${SECRET}\nsecond-line`)).toThrow(/line breaks/);
  });

  it('parses local values without interpolation and rejects malformed or duplicate declarations', () => {
    expect(parseDevVars([
      '# local deployment values',
      'VIDNEST_ORIGIN_URL=https://app.lumora.example.org',
      `VIDNEST_API_SECRET='${SECRET}'`,
      'export CLOUDFLARE_ACCOUNT_ID="0123456789abcdef0123456789abcdef"',
    ].join('\n'))).toEqual({
      VIDNEST_ORIGIN_URL: 'https://app.lumora.example.org',
      VIDNEST_API_SECRET: SECRET,
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    });
    expect(() => parseDevVars('INVALID LINE')).toThrow(/line 1/);
    expect(() => parseDevVars('VALUE=one\nVALUE=two')).toThrow(/Duplicate VALUE/);
  });

  it('lets process values override ignored local values and keeps the secret out of Wrangler arguments', () => {
    const config = deploymentConfig({
      NODE_ENV: 'test',
      VIDNEST_ORIGIN_URL: 'https://app.lumora.example.org',
      VIDNEST_CDN_PUBLIC_URL: 'https://lumora-vidnest-cdn.example.workers.dev/media',
      VIDNEST_API_SECRET: SECRET,
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
      CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
    }, [
      'VIDNEST_ORIGIN_URL=https://other.lumora.example.org',
      'VIDNEST_CDN_PUBLIC_URL=https://other-cdn.example.workers.dev/media',
      'VIDNEST_API_SECRET=another-worker-deployment-secret-value',
    ].join('\n'));
    expect(config.origin).toBe('https://app.lumora.example.org');
    expect(config.publicUrl).toBe('https://lumora-vidnest-cdn.example.workers.dev/media');
    expect(config.auth).toEqual({
      CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
      CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    });

    const secretsFile = 'C:\\secure\\worker-secrets.json';
    const steps = deploymentSteps(config.origin, secretsFile);
    expect(JSON.stringify(steps.map((step) => step.args))).not.toContain(SECRET);
    expect(steps).toHaveLength(2);
    expect(steps[1]?.args).toContain('VIDNEST_ORIGIN_URL:https://app.lumora.example.org');
    expect(steps[1]?.args).toContain('--secrets-file');
    expect(steps[1]?.args).toContain(secretsFile);
  });
});
