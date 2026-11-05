import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/generated/auth-schema.ts",
  out: "./migrations",
});
