import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
