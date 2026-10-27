import { describe, expect, it } from 'vitest';
import { DEFAULT_VAST_CONFIGURATION } from '@/features/commerce/types';
import { commerceReasonSchema, isPublicAdHost, planInputSchema, publicPlaybackPolicy, vastConfigurationSchema } from '@/features/commerce/validation';
import { formatPlanPrice } from '@/features/commerce/CommerceFields';

const plan = { slug: 'premium', name: 'Premium', description: 'Ad-free access', currency: 'USD', priceMinor: 999,
  billingInterval: 'month', adFree: true, maxProfiles: 4, features: ['No ads'] };
const vast = { ...DEFAULT_VAST_CONFIGURATION, enabled: true, tagUrl: 'https://ads.example.com/vast?token=private', allowedHosts: ['ads.example.com'] };

describe('commerce plan validation', () => {
  it('accepts configurable plan metadata with integer minor-unit prices', () => {
    expect(planInputSchema.parse(plan)).toEqual(plan);
  });
  it.each([-1, 1.5, Infinity, 100000001])('rejects invalid price %s', (priceMinor) => {
    expect(planInputSchema.safeParse({ ...plan, priceMinor }).success).toBe(false);
  });
  it.each([0, 21, 2.5])('rejects invalid profile limit %s', (maxProfiles) => {
    expect(planInputSchema.safeParse({ ...plan, maxProfiles }).success).toBe(false);
  });
  it('rejects provider/checkout activation fields', () => {
    expect(planInputSchema.safeParse({ ...plan, paymentProvider: 'fake', active: true }).success).toBe(false);
  });
  it('requires bounded text features and a meaningful reason', () => {
    expect(planInputSchema.safeParse({ ...plan, features: Array(31).fill('feature') }).success).toBe(false);
    expect(planInputSchema.safeParse({ ...plan, features: [''] }).success).toBe(false);
    expect(commerceReasonSchema.safeParse('   ').success).toBe(false);
  });
  it('formats minor-unit currencies without assuming two decimals', () => {
    expect(formatPlanPrice({ currency: 'USD', priceMinor: 999 })).toBe('$9.99');
    expect(formatPlanPrice({ currency: 'JPY', priceMinor: 999 })).toContain('999');
    expect(formatPlanPrice({ currency: 'KWD', priceMinor: 999 })).toContain('0.999');
  });
});

describe('private VAST validation', () => {
  it('keeps the global default disabled and allows an empty unconfigured provider', () => {
    expect(vastConfigurationSchema.parse(DEFAULT_VAST_CONFIGURATION).enabled).toBe(false);
  });
  it('accepts an explicit public HTTPS allowlist and normalizes the tag', () => {
    expect(vastConfigurationSchema.parse(vast)).toEqual(vast);
    expect(vastConfigurationSchema.parse({ ...vast, tagUrl: 'HTTPS://ADS.EXAMPLE.COM:443/vast' }).tagUrl).toBe('https://ads.example.com/vast');
  });
  it.each(['http://ads.example.com/vast', 'https://127.0.0.1/vast', 'https://[::1]/vast', 'https://10.0.0.1/vast',
    'https://localhost/vast', 'https://ads.example.com:8443/vast', 'https://user:pass@ads.example.com/vast',
    'https://ads.example.com/vast#secret', 'https://evil.example.com/vast', 'https://ads.example.com.evil.com/vast',
    'https://2130706433/vast', 'https://0x7f000001/vast'])('rejects unsafe VAST tag %s', (tagUrl) => {
    expect(vastConfigurationSchema.safeParse({ ...vast, tagUrl }).success).toBe(false);
  });
  it.each(['*.example.com', 'https://ads.example.com', '127.0.0.1', '192.168.1.1', 'a.internal', 'a.local', 'a.home.arpa',
    'a.test', 'localhost', 'ADS.EXAMPLE.COM'])('rejects unsafe allowlist host %s', (host) => {
    expect(isPublicAdHost(host)).toBe(false);
  });
  it('requires a tag and at least one break when enabled', () => {
    expect(vastConfigurationSchema.safeParse({ ...vast, tagUrl: '' }).success).toBe(false);
    expect(vastConfigurationSchema.safeParse({ ...vast, maxBreaks: 0 }).success).toBe(false);
  });
  it.each([{ firstBreakSeconds: 59 }, { intervalSeconds: 0 }, { maxBreaks: 21 }, { skipAfterSeconds: 31 },
    { intervalSeconds: 1.5 }, { firstBreakSeconds: Infinity }])('rejects invalid scheduling %j', (change) => {
    expect(vastConfigurationSchema.safeParse({ ...vast, ...change }).success).toBe(false);
  });
  it('strips all private provider data from public scheduling', () => {
    const policy = publicPlaybackPolicy(vast);
    expect(Object.keys(policy).sort()).toEqual(['enabled', 'firstBreakSeconds', 'intervalSeconds', 'maxBreaks', 'allowSkip', 'skipAfterSeconds'].sort());
    expect(JSON.stringify(policy)).not.toContain('private');
    expect(policy).not.toHaveProperty('tagUrl');
    expect(policy).not.toHaveProperty('allowedHosts');
  });
});
