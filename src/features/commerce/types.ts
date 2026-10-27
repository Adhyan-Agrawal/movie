export interface ViewerEntitlements {
  resolved: boolean;
  adFree: boolean;
  maxProfiles: number;
  status: 'free' | 'active' | 'expired' | 'unavailable';
  planId?: string;
  planName?: string;
  accessUntil?: string;
}

/** Public scheduling only. VAST tags and provider secrets stay on the server. */
export interface PlaybackAdPolicy {
  enabled: boolean;
  firstBreakSeconds: number;
  intervalSeconds: number;
  maxBreaks: number;
  allowSkip: boolean;
  skipAfterSeconds: number;
}

export interface VastConfiguration extends PlaybackAdPolicy {
  tagUrl: string;
  allowedHosts: string[];
}

export interface PlaybackCommerceContext {
  entitlements: ViewerEntitlements;
  ads: PlaybackAdPolicy;
}

export const FREE_ENTITLEMENTS: ViewerEntitlements = {
  resolved: true, adFree: false, maxProfiles: 1, status: 'free',
};

export const DEFAULT_VAST_CONFIGURATION: VastConfiguration = {
  enabled: false, tagUrl: '', allowedHosts: [], firstBreakSeconds: 900,
  intervalSeconds: 900, maxBreaks: 3, allowSkip: true, skipAfterSeconds: 5,
};

export interface CommercePlan {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  currency: string;
  priceMinor: number;
  billingInterval: 'month' | 'year' | 'one_time';
  adFree: boolean;
  maxProfiles: number;
  features: string[];
  status: 'draft' | 'published' | 'archived';
  publishedAt: string | null;
}

export interface CommerceSubscription {
  id: string;
  accountId: string;
  planId: string;
  status: 'active' | 'revoked';
  startsAt: string;
  accessUntil: string;
  reason: string;
  source: 'admin_grant';
}

export interface CommerceActionState {
  ok: boolean;
  error?: string;
}
