import { describe, expect, it } from "vitest";
import { runtimeReadiness, type RuntimeReadinessEnv } from "../src/readiness";

const production: RuntimeReadinessEnv = {
  RUNTIME_ENV: "production",
  PRODUCTION_READY: "true",
  EMAIL_SENDING_READY: "true",
  AUTH_BASE_URL: "https://api.lumora.example.com",
  TRUSTED_WEB_ORIGINS: "https://app.lumora.example.com",
  PASSKEY_RP_ID: "lumora.example.com",
  PASSKEY_ORIGIN: "https://api.lumora.example.com",
  EMAIL_FROM: "Lumora <noreply@lumora.example.com>",
  BETTER_AUTH_SECRET: "a".repeat(32),
  MEDIA_SIGNING_SECRET: "b".repeat(32),
};

describe("production readiness gate", () => {
  it("fails closed for the checked-in placeholder configuration", () => {
    const result = runtimeReadiness({
      ...production,
      RUNTIME_ENV: "unconfigured",
      PRODUCTION_READY: "false",
      EMAIL_SENDING_READY: "false",
      AUTH_BASE_URL: "http://localhost:8787",
      PASSKEY_RP_ID: "localhost",
      PASSKEY_ORIGIN: "http://localhost:8787",
      TRUSTED_WEB_ORIGINS: "http://localhost:3000",
      EMAIL_FROM: "Lumora <noreply@example.invalid>",
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "runtime_environment_unconfigured",
      "data_cutover_not_attested",
      "email_domain_not_attested",
      "email_sender_not_production_ready",
    ]));
  });

  it("requires every explicit production prerequisite", () => {
    expect(runtimeReadiness(production)).toEqual({ ready: true, mode: "production", blockers: [] });
  });
});
