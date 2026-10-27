import { z } from 'zod';
import { isPrivateOrLoopbackHost } from '@/lib/validation/source';
import type { PlaybackAdPolicy, VastConfiguration, ViewerEntitlements } from './types';

export const commerceReasonSchema = z.string().trim().min(5).max(1000);
export const planInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  priceMinor: z.number().int().min(0).max(100000000),
  billingInterval: z.enum(['month', 'year', 'one_time']),
  adFree: z.boolean(),
  maxProfiles: z.number().int().min(1).max(20),
  features: z.array(z.string().trim().min(1).max(160)).max(30),
}).strict();

export function isPublicAdHost(host: string): boolean {
  return host === host.toLowerCase() && host.length <= 253 &&
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) &&
    !isPrivateOrLoopbackHost(host) && !/\.(?:local|localhost|internal|lan|home|test|invalid)$/.test(host);
}

export const vastConfigurationSchema = z.object({
  enabled: z.boolean(),
  tagUrl: z.string().trim().max(4096),
  allowedHosts: z.array(z.string().trim().refine(isPublicAdHost, 'Use exact public DNS hostnames, not URLs, IPs or wildcards.')).max(30),
  firstBreakSeconds: z.number().int().min(60).max(86400),
  intervalSeconds: z.number().int().min(60).max(86400),
  maxBreaks: z.number().int().min(0).max(20),
  allowSkip: z.boolean(),
  skipAfterSeconds: z.number().int().min(0).max(30),
}).strict().superRefine((config, ctx) => {
  if (!config.tagUrl) {
    if (config.enabled) ctx.addIssue({ code: 'custom', path: ['tagUrl'], message: 'An enabled VAST policy needs a tag URL.' });
    return;
  }
  try {
    const url = new URL(config.tagUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !isPublicAdHost(url.hostname) || !config.allowedHosts.includes(url.hostname)) {
      throw new Error('invalid');
    }
    config.tagUrl = url.toString();
  } catch {
    ctx.addIssue({ code: 'custom', path: ['tagUrl'], message: 'VAST tag must be public HTTPS on an explicitly allowed host, without credentials or a fragment.' });
  }
  if (config.enabled && config.maxBreaks < 1) ctx.addIssue({ code: 'custom', path: ['maxBreaks'], message: 'Enabled ads require at least one break.' });
});

export const viewerEntitlementsSchema: z.ZodType<ViewerEntitlements> = z.object({
  resolved: z.boolean(), adFree: z.boolean(), maxProfiles: z.number().int().min(1).max(20),
  status: z.enum(['free', 'active', 'expired', 'unavailable']),
  planId: z.string().uuid().optional(), planName: z.string().optional(), accessUntil: z.string().datetime({ offset: true }).optional(),
});

export function publicPlaybackPolicy(config: VastConfiguration): PlaybackAdPolicy {
  return { enabled: config.enabled, firstBreakSeconds: config.firstBreakSeconds, intervalSeconds: config.intervalSeconds,
    maxBreaks: config.maxBreaks, allowSkip: config.allowSkip, skipAfterSeconds: config.skipAfterSeconds };
}
