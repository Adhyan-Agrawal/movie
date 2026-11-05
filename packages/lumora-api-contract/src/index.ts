export const API_VERSION = "v1" as const;
export const API_PREFIX = `/${API_VERSION}` as const;
export const AUTH_PREFIX = `${API_PREFIX}/auth` as const;

export const API_LIMITS = {
  bodyBytes: 256 * 1024,
  queryCharacters: 2_048,
  pageSizeDefault: 24,
  pageSizeMaximum: 50,
  bulkIdsMaximum: 90,
  freeTextMaximum: 2_000,
} as const;

export const PERMISSION_KEYS = [
  "catalog.read",
  "catalog.create",
  "catalog.publish",
  "catalog.delete",
  "provider.manage",
  "ads.manage",
  "email.manage",
  "users.read",
  "users.suspend",
  "roles.manage",
  "analytics.read",
  "settings.manage",
  "audit.read",
  "health.read",
  "plans.manage",
  "billing.read",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type RoleKey = "owner" | "admin" | "editor" | "viewer";
export type UUID = string;
export type IsoDateTime = string;
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ApiErrorCode =
  | "bad_request"
  | "body_too_large"
  | "conflict"
  | "forbidden"
  | "internal_error"
  | "method_not_allowed"
  | "not_found"
  | "rate_limited"
  | "session_suspended"
  | "service_unavailable"
  | "unauthorized"
  | "validation_error";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    fields?: Record<string, string>;
  };
}

export interface CursorPage<T> {
  data: T[];
  page: {
    nextCursor: string | null;
    limit: number;
  };
}

export interface AccountDto {
  id: UUID;
  email: string;
  emailVerified: boolean;
  displayName: string;
  imageUrl: string | null;
  isSuspended: boolean;
  roles: RoleKey[];
  permissions: PermissionKey[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface SessionDto {
  authenticated: boolean;
  account: AccountDto | null;
  expiresAt: IsoDateTime | null;
}

export interface RuntimeReadinessDto {
  ready: boolean;
  mode: string;
  blockers: string[];
}

export interface ProfileDto {
  id: UUID;
  name: string;
  avatar: string | null;
  maturityCeiling: string;
  isKids: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TitleDto {
  id: UUID;
  type: "movie" | "tv";
  slug: string;
  name: string;
  originalName?: string;
  synopsis: string;
  releaseYear: number | null;
  runtimeMinutes: number | null;
  maturity: string;
  genres: string[];
  originalLanguage: string;
  posterUrl: string | null;
  backdropUrl: string | null;
  trailerUrl: string | null;
  featured: boolean;
  score: number | null;
  popularity: number | null;
  tmdbId: string | null;
  imdbId: string | null;
}

export interface WatchlistItemDto {
  title: TitleDto;
  sortOrder: number;
  addedAt: IsoDateTime;
}

export interface ProgressDto {
  id: UUID;
  profileId: UUID;
  titleId: UUID;
  episodeId: UUID | null;
  positionSeconds: number;
  durationSeconds: number | null;
  progress: number;
  completed: boolean;
  updatedAt: IsoDateTime;
}

export interface RatingDto {
  id: UUID;
  profileId: UUID;
  titleId: UUID;
  value: number;
  updatedAt: IsoDateTime;
}

export interface PlaybackSourceDto {
  id: string;
  label: string;
  kind: "mp4" | "hls" | "dash" | "youtube" | "vimeo" | "dailymotion" | "vsembed" | "iframe" | "embed" | "custom";
  url?: string;
  streamCatalogUrl?: string;
  consentRequired: boolean;
}

export interface EntitlementsDto {
  resolved: boolean;
  adFree: boolean;
  maxProfiles: number;
  status: "active" | "expired" | "free" | "unavailable";
  planId?: UUID;
  planName?: string;
  accessUntil?: IsoDateTime;
}

export interface PlaybackResolveDto {
  sources: PlaybackSourceDto[];
  entitlements: EntitlementsDto;
  subtitleCatalogUrl?: string;
  introCatalogUrl?: string;
}

export interface PlanDto {
  id: UUID;
  slug: string;
  version: number;
  name: string;
  description: string;
  currency: string;
  priceMinor: number;
  billingInterval: "month" | "year" | "one_time";
  adFree: boolean;
  maxProfiles: number;
  features: Json[];
  status: "draft" | "published" | "archived";
  publishedAt: IsoDateTime | null;
}

export interface TitleRequestDto {
  id: UUID;
  titleName: string;
  mediaType: "movie" | "tv";
  year: number | null;
  note: string | null;
  status: "pending" | "imported" | "rejected";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ProviderDto {
  id: UUID;
  key: string;
  name: string;
  adapter: string;
  enabled: boolean;
  priority: number;
  timeoutMs: number;
  health: "unknown" | "healthy" | "degraded" | "down";
  updatedAt: IsoDateTime;
}

export interface MediaCapabilityDto {
  url: string;
  prefix: string;
  expiresAt: IsoDateTime;
  rangeSupported: true;
}

export interface TranscodeJobDto {
  id: UUID;
  inputKey: string;
  outputPrefix: string;
  preset: "hls-1080p" | "hls-adaptive";
  status: "queued" | "running" | "completed" | "failed";
  createdAt: IsoDateTime;
}

export interface OutboxMessage<T extends Json = Json> {
  id: UUID;
  topic: string;
  payload: T;
  attempt: number;
  createdAt: IsoDateTime;
}

export const AUTH_COOKIE_CONTRACT = {
  basePath: AUTH_PREFIX,
  cookiePrefix: "lumora",
  attributes: {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    hostOnly: true,
  },
  webCredentials: "include",
  mobileCredentials: "omit",
  mobileStorage: "expo-secure-store",
  mobileTransport: "Cookie header returned by @better-auth/expo getCookie()",
} as const;

export const AUTHORIZATION_MATRIX = {
  publicRead: [
    "GET /v1/health",
    "GET /v1/catalog/titles",
    "GET /v1/catalog/titles/:titleId",
    "GET /v1/catalog/genres",
    "GET /v1/commerce/plans",
    "GET /v1/commerce/entitlements",
    "GET /v1/settings",
  ],
  authenticatedSelf: [
    "GET /v1/session",
    "GET|PATCH /v1/account",
    "GET|POST /v1/profiles",
    "PATCH|DELETE /v1/profiles/:profileId",
    "GET|PUT|DELETE /v1/profiles/:profileId/watchlist",
    "GET|PUT /v1/profiles/:profileId/progress",
    "PUT|DELETE /v1/profiles/:profileId/ratings",
    "POST /v1/playback/sessions",
    "GET|POST /v1/requests",
  ],
  permission: {
    "provider.manage": ["GET|POST /v1/providers", "POST /v1/media/capabilities", "POST /v1/admin/media/transcodes"],
    "ads.manage": ["PUT /v1/admin/ads/vast"],
    "catalog.create": ["POST /v1/admin/catalog/titles"],
    "catalog.publish": ["POST /v1/admin/catalog/titles?status=published"],
    "users.read": ["GET /v1/admin/accounts"],
    "users.suspend": ["PUT /v1/admin/accounts/:accountId/suspension"],
    "settings.manage": ["PUT /v1/admin/settings/:key"],
    "audit.read": ["GET /v1/admin/audit"],
    "plans.manage": ["POST /v1/admin/plans", "POST /v1/admin/plans/:planId/publish", "POST /v1/admin/subscriptions", "POST /v1/admin/subscriptions/:subscriptionId/revoke"],
  },
} as const;
