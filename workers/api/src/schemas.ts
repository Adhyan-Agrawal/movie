import { z } from "zod";

export const uuidSchema = z.string().uuid();
const shortText = z.string().trim().min(1).max(300);
const nullableUrl = z.string().url().max(2048).nullable().optional();

export const accountUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
}).strict();

export const profileCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  avatar: z.string().max(2048).nullable().optional(),
  maturityCeiling: z.string().trim().min(1).max(20).optional(),
  isKids: z.boolean().optional(),
}).strict();

export const profileUpdateSchema = profileCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one profile field is required.",
);

export const progressSchema = z.object({
  episodeId: uuidSchema.nullable().optional(),
  positionSeconds: z.number().int().min(0).max(10_000_000),
  durationSeconds: z.number().int().min(0).max(10_000_000).nullable().optional(),
  completed: z.boolean().optional(),
}).strict();

export const ratingSchema = z.object({ value: z.number().int().min(1).max(10) }).strict();

export const playbackSessionSchema = z.object({
  profileId: uuidSchema.nullable().optional(),
  titleId: uuidSchema,
  episodeId: uuidSchema.nullable().optional(),
  sourceId: uuidSchema.nullable().optional(),
  device: z.string().trim().max(200).nullable().optional(),
  state: z.string().trim().min(1).max(32).optional(),
}).strict();

export const titleRequestSchema = z.object({
  titleName: shortText,
  mediaType: z.enum(["movie", "tv"]).default("movie"),
  year: z.number().int().min(1878).max(2100).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
}).strict();

export const playbackReportSchema = z.object({
  titleId: uuidSchema.nullable().optional(),
  episodeId: uuidSchema.nullable().optional(),
  serverLabel: z.string().trim().max(100).nullable().optional(),
  playerState: z.string().trim().max(100).nullable().optional(),
  message: z.string().trim().max(2000).nullable().optional(),
}).strict().superRefine((value, context) => {
  const diagnostic = `${value.serverLabel ?? ""} ${value.playerState ?? ""} ${value.message ?? ""}`;
  if (/(?:https?:\/\/|authorization|bearer\s|token=|api[_-]?key)/iu.test(diagnostic)) {
    context.addIssue({ code: "custom", message: "Reports must not contain URLs or credentials." });
  }
});

export const mediaCapabilitySchema = z.object({
  objectPrefix: z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u),
  ttlSeconds: z.number().int().min(30).max(900).optional(),
}).strict();

const providerConfigSchema = z.record(z.string().max(100), z.unknown()).superRefine((value, context) => {
  const forbidden = /(?:secret|token|password|credential|api[_-]?key|authorization)/iu;
  if (Object.keys(value).some((key) => forbidden.test(key))) {
    context.addIssue({ code: "custom", message: "Provider secrets must use Worker secret bindings." });
  }
});

export const providerCreateSchema = z.object({
  key: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().trim().min(1).max(200),
  adapter: z.string().trim().min(1).max(100).default("generic"),
  enabled: z.boolean().default(true),
  baseUrl: nullableUrl,
  allowedDomains: z.array(z.string().trim().min(1).max(253)).max(30).default([]),
  priority: z.number().int().min(0).max(10000).default(100),
  timeoutMs: z.number().int().min(100).max(30000).default(8000),
  enabledRegions: z.array(z.string().trim().min(2).max(8)).max(100).default([]),
  consentRequired: z.boolean().default(false),
  config: providerConfigSchema.default({}),
  reason: z.string().trim().min(5).max(1000),
}).strict().superRefine((value, context) => {
  if (!value.baseUrl) return;
  const parsed = new URL(value.baseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || hasSensitiveQuery(parsed)) {
    context.addIssue({ code: "custom", path: ["baseUrl"], message: "Provider base URL must be credential-free HTTPS." });
  }
});

export const suspensionSchema = z.object({
  suspended: z.boolean(),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const settingSchema = z.object({
  value: z.unknown(),
  isPublic: z.boolean().default(false),
  description: z.string().max(1000).default(""),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const planCreateSchema = z.object({
  slug: z.string().min(2).max(64).regex(/^[a-z0-9][a-z0-9-]+$/u),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  currency: z.string().length(3).regex(/^[A-Z]{3}$/u),
  priceMinor: z.number().int().min(0).max(100_000_000),
  billingInterval: z.enum(["month", "year", "one_time"]),
  adFree: z.boolean().default(false),
  maxProfiles: z.number().int().min(1).max(20).default(1),
  features: z.array(z.unknown()).max(30).default([]),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const subscriptionGrantSchema = z.object({
  accountId: uuidSchema,
  planId: uuidSchema,
  accessUntil: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const auditedReasonSchema = z.object({
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const catalogTitleCreateSchema = z.object({
  type: z.enum(["movie", "tv"]),
  slug: z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().trim().min(1).max(300),
  originalName: z.string().trim().max(300).nullable().optional(),
  synopsis: z.string().max(20000).default(""),
  releaseYear: z.number().int().min(1878).max(2100).nullable().optional(),
  runtimeMinutes: z.number().int().min(0).max(10000).nullable().optional(),
  maturity: z.string().trim().min(1).max(20).default("NR"),
  status: z.enum(["draft", "scheduled", "published", "archived"]).default("draft"),
  visibility: z.enum(["public", "private"]).default("public"),
  originalLanguage: z.string().trim().min(2).max(16).default("en"),
  posterUrl: nullableUrl,
  backdropUrl: nullableUrl,
  trailerUrl: nullableUrl,
  featured: z.boolean().default(false),
  editorialScore: z.number().int().min(0).max(100).nullable().optional(),
  tmdbId: z.number().int().positive().nullable().optional(),
  imdbId: z.string().trim().max(32).nullable().optional(),
  publishedAt: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().min(5).max(1000),
}).strict();

export const transcodeJobSchema = z.object({
  inputKey: z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
  outputPrefix: z.string().trim().min(1).max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*\/$/u),
  preset: z.enum(["hls-1080p", "hls-adaptive"]),
  reason: z.string().trim().min(5).max(1000),
}).strict().refine(
  (value) => !value.inputKey.split("/").includes("..") && !value.outputPrefix.split("/").includes(".."),
  "Media keys must not contain traversal segments.",
);

export const vastSettingsSchema = z.object({
  enabled: z.boolean(),
  tagUrl: z.string().max(2048),
  allowedHosts: z.array(z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/u)).max(50),
  firstBreakSeconds: z.number().int().min(0).max(86400),
  intervalSeconds: z.number().int().min(60).max(86400),
  maxBreaks: z.number().int().min(0).max(20),
  allowSkip: z.boolean(),
  skipAfterSeconds: z.number().int().min(0).max(300),
  reason: z.string().trim().min(5).max(1000),
}).strict().superRefine((value, context) => {
  if (!value.tagUrl && !value.enabled) return;
  if (!value.tagUrl) {
    context.addIssue({ code: "custom", path: ["tagUrl"], message: "Enabled VAST requires a tag URL." });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value.tagUrl);
  } catch {
    context.addIssue({ code: "custom", path: ["tagUrl"], message: "VAST tag URL is invalid." });
    return;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    context.addIssue({ code: "custom", path: ["tagUrl"], message: "VAST tag URL must be credential-free HTTPS." });
  }
  if (hasSensitiveQuery(parsed)) {
    context.addIssue({ code: "custom", path: ["tagUrl"], message: "VAST credentials must use Worker secret bindings." });
  }
  const host = parsed.hostname.toLowerCase();
  if (value.enabled && !value.allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    context.addIssue({ code: "custom", path: ["allowedHosts"], message: "Enabled VAST host must be explicitly allowed." });
  }
  if (isPrivateHost(host)) {
    context.addIssue({ code: "custom", path: ["tagUrl"], message: "Private or loopback VAST hosts are forbidden." });
  }
});

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^(?:127\.|10\.|0\.|169\.254\.|192\.168\.)/u.test(host)) return true;
  const match = /^172\.(\d{1,3})\./u.exec(host);
  if (match?.[1] && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

function hasSensitiveQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) =>
    /(?:secret|token|password|credential|api[_-]?key|authorization|signature)/iu.test(key));
}
