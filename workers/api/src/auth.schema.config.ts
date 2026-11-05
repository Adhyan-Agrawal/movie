import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";

// This config is loaded only by the pinned Better Auth CLI to generate the
// authoritative Drizzle schema. Runtime secrets and bindings are intentionally
// absent so schema generation cannot contact production infrastructure.
export const auth = betterAuth({
  appName: "Lumora",
  baseURL: "http://localhost:8787",
  basePath: "/v1/auth",
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
  },
  user: {
    modelName: "accounts",
    fields: {
      name: "display_name",
      emailVerified: "email_verified",
      image: "image_url",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    additionalFields: {
      isSuspended: {
        type: "boolean",
        required: true,
        defaultValue: false,
        input: false,
        fieldName: "is_suspended",
      },
    },
  },
  session: {
    modelName: "auth_sessions",
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  account: {
    modelName: "auth_accounts",
    encryptOAuthTokens: true,
  },
  verification: {
    modelName: "auth_verifications",
    storeIdentifier: "hashed",
  },
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "auth_rate_limits",
  },
  advanced: {
    cookiePrefix: "lumora",
    useSecureCookies: true,
    database: {
      generateId: "uuid",
      defaultFindManyLimit: 50,
      joins: true,
    },
  },
  plugins: [
    expo(),
    passkey({
      rpID: "localhost",
      rpName: "Lumora",
      origin: "http://localhost:8787",
      authenticatorSelection: { userVerification: "required" },
      registration: { requireSession: true },
    }),
  ],
});
