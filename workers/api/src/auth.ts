import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/d1";
import {
  passwordResetTask,
  scheduleAuthEmail,
  verificationTask,
  type AuthEmailSender,
  type EmailFailureMode,
} from "./auth-email";
import { ensureAccountFoundation } from "./foundation";
import * as schema from "./generated/auth-schema";
import { parseExactOrigins } from "./security";

export interface CreateAuthOptions {
  requestId?: string;
  emailSender?: AuthEmailSender;
  emailFailureMode?: EmailFailureMode;
}

export function createAuth(env: Env, executionContext?: ExecutionContext, runtime: CreateAuthOptions = {}) {
  const database = drizzle(env.DB, { schema });
  return betterAuth({
    appName: "Lumora",
    baseURL: env.AUTH_BASE_URL,
    basePath: "/v1/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(database, { provider: "sqlite", schema }),
    trustedOrigins: [...parseExactOrigins(env)],
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => scheduleAuthEmail(
        env,
        verificationTask(user.id, user.email, url),
        {
          executionContext,
          failureMode: runtime.emailFailureMode ?? "queue",
          requestId: runtime.requestId,
          sender: runtime.emailSender,
        },
      ),
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 60 * 60,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => scheduleAuthEmail(
        env,
        passwordResetTask(user.id, user.email, url),
        {
          executionContext,
          failureMode: runtime.emailFailureMode ?? "queue",
          requestId: runtime.requestId,
          sender: runtime.emailSender,
        },
      ),
      password: {
        hash: hashPassword,
        verify: verifySupportedPassword,
      },
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
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "auth_accounts",
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
    },
    verification: {
      modelName: "auth_verifications",
      storeIdentifier: "hashed",
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 300, max: 3 },
        "/send-verification-email": { window: 300, max: 3 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => ensureAccountFoundation(env.DB, user.id, user.name),
        },
      },
      session: {
        create: {
          before: async (session) => {
            const account = await env.DB.prepare(
              "SELECT is_suspended FROM accounts WHERE id = ?",
            ).bind(session.userId).first<{ is_suspended: number }>();
            return account?.is_suspended !== 1;
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "lumora",
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      trustedProxyHeaders: false,
      database: {
        generateId: "uuid",
        defaultFindManyLimit: 50,
        joins: true,
      },
      ...(executionContext
        ? { backgroundTasks: { handler: (promise: Promise<unknown>) => executionContext.waitUntil(promise) } }
        : {}),
    },
    logger: {
      disabled: false,
      disableColors: true,
      level: "error",
      log: (level) => console.log(JSON.stringify({
        event: "better_auth_log",
        level,
        requestId: runtime.requestId,
      })),
    },
    onAPIError: {
      onError: () => console.log(JSON.stringify({ event: "auth_request_failed", requestId: runtime.requestId })),
    },
    plugins: [
      expo(),
      passkey({
        rpID: env.PASSKEY_RP_ID,
        rpName: "Lumora",
        origin: env.PASSKEY_ORIGIN,
        authenticatorSelection: { userVerification: "required" },
        registration: { requireSession: true },
      }),
    ],
  });
}

export type LumoraAuth = ReturnType<typeof createAuth>;

export async function verifySupportedPassword(input: { hash: string; password: string }): Promise<boolean> {
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/iu.test(input.hash)) {
    // Match the unknown-user work factor without accepting or parsing legacy
    // hashes. Legacy bcrypt users must complete the password-reset claim flow.
    await hashPassword(input.password);
    return false;
  }
  try {
    return await verifyPassword(input);
  } catch {
    await hashPassword(input.password);
    return false;
  }
}
