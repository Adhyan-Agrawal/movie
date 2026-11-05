import { ApiHttpError } from "./http";

export interface RuntimeReadinessEnv {
  RUNTIME_ENV: string;
  PRODUCTION_READY: string;
  EMAIL_SENDING_READY: string;
  AUTH_BASE_URL: string;
  TRUSTED_WEB_ORIGINS: string;
  PASSKEY_RP_ID: string;
  PASSKEY_ORIGIN: string;
  EMAIL_FROM: string;
  BETTER_AUTH_SECRET: string;
  MEDIA_SIGNING_SECRET: string;
}

export interface RuntimeReadiness {
  ready: boolean;
  mode: string;
  blockers: string[];
}

export function runtimeReadiness(env: RuntimeReadinessEnv): RuntimeReadiness {
  const mode = env.RUNTIME_ENV.trim().toLowerCase();
  if (mode === "local" || mode === "test") return { ready: true, mode, blockers: [] };

  const blockers: string[] = [];
  if (mode !== "production") blockers.push("runtime_environment_unconfigured");
  if (env.PRODUCTION_READY !== "true") blockers.push("data_cutover_not_attested");
  if (env.EMAIL_SENDING_READY !== "true") blockers.push("email_domain_not_attested");
  if (!secureUrl(env.AUTH_BASE_URL)) blockers.push("auth_base_url_not_https");
  if (!secureUrl(env.PASSKEY_ORIGIN)) blockers.push("passkey_origin_not_https");
  if (!validPasskeyRp(env.PASSKEY_RP_ID, env.PASSKEY_ORIGIN)) blockers.push("passkey_rp_mismatch");
  if (!validWebOrigins(env.TRUSTED_WEB_ORIGINS)) blockers.push("trusted_web_origins_not_https");
  if (!validProductionSender(env.EMAIL_FROM)) blockers.push("email_sender_not_production_ready");
  if (env.BETTER_AUTH_SECRET.length < 32) blockers.push("better_auth_secret_too_short");
  if (env.MEDIA_SIGNING_SECRET.length < 32) blockers.push("media_signing_secret_too_short");
  if (env.BETTER_AUTH_SECRET === env.MEDIA_SIGNING_SECRET) blockers.push("secrets_must_be_independent");
  return { ready: blockers.length === 0, mode, blockers };
}

export function assertRuntimeReady(env: RuntimeReadinessEnv): void {
  if (!runtimeReadiness(env).ready) {
    throw new ApiHttpError(503, "service_unavailable", "Service is not ready.");
  }
}

export function assertEmailDeliveryReady(env: RuntimeReadinessEnv): void {
  const mode = env.RUNTIME_ENV.trim().toLowerCase();
  if (mode === "local" || mode === "test") return;
  const readiness = runtimeReadiness(env);
  if (!readiness.ready || env.EMAIL_SENDING_READY !== "true") {
    throw new EmailDeliveryConfigurationError();
  }
}

export class EmailDeliveryConfigurationError extends Error {
  readonly code = "EMAIL_DELIVERY_NOT_READY";

  constructor() {
    super("Email delivery is not ready.");
  }
}

function secureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !reservedHostname(url.hostname);
  } catch {
    return false;
  }
}

function validPasskeyRp(rpId: string, origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const normalizedRp = rpId.trim().toLowerCase();
    return normalizedRp !== "localhost" &&
      (hostname === normalizedRp || hostname.endsWith(`.${normalizedRp}`));
  } catch {
    return false;
  }
}

function validWebOrigins(value: string): boolean {
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return origins.length > 0 && origins.every((entry) => secureUrl(entry));
}

function validProductionSender(value: string): boolean {
  const match = /(?:<)?([^<>\s]+@([^<>\s]+))(?:>)?\s*$/u.exec(value);
  const domain = match?.[2]?.toLowerCase();
  return Boolean(domain && domain.includes(".") && !reservedHostname(domain));
}

function reservedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || [".invalid", ".test", ".example"].some((suffix) => value.endsWith(suffix));
}
