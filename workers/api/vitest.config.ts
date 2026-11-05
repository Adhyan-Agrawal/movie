import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

process.env.BETTER_AUTH_SECRET = "test-only-better-auth-secret-32-bytes-minimum";
process.env.MEDIA_SIGNING_SECRET = "test-only-media-signing-secret-32-bytes-minimum";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          RUNTIME_ENV: "test",
          PRODUCTION_READY: "false",
          EMAIL_SENDING_READY: "false",
          BETTER_AUTH_SECRET: "test-only-better-auth-secret-32-bytes-minimum",
          MEDIA_SIGNING_SECRET: "test-only-media-signing-secret-32-bytes-minimum",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
