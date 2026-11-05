import { DurableObject } from "cloudflare:workers";
import type { ApiErrorCode, ProfileDto } from "@lumora/api-contract";
import { ApiHttpError } from "./http";
import type { ProfileInput } from "./repository";
import { Repository } from "./repository";

interface PlanInput {
  slug: string;
  name: string;
  description: string;
  currency: string;
  priceMinor: number;
  billingInterval: "month" | "year" | "one_time";
  adFree: boolean;
  maxProfiles: number;
  features: unknown[];
  reason: string;
}

type CoordinatorResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: ApiErrorCode; message: string };

export class AccountCoordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  async createProfile(accountId: string, input: ProfileInput): Promise<CoordinatorResult<ProfileDto>> {
    try {
      const value = await this.serialized(accountId, async () =>
        new Repository(this.env.DB).createProfileSerialized(accountId, input));
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ApiHttpError) {
        return { ok: false, status: error.status, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  async deleteProfile(accountId: string, profileId: string): Promise<void> {
    await this.serialized(accountId, async () => new Repository(this.env.DB).deleteProfileSerialized(accountId, profileId));
  }

  async setSuspension(
    actorId: string,
    accountId: string,
    suspended: boolean,
    reason: string,
    requestId: string,
  ) {
    return this.serialized(accountId, async () =>
      new Repository(this.env.DB).setSuspension(actorId, accountId, suspended, reason, requestId));
  }

  async grantSubscription(
    actorId: string,
    accountId: string,
    planId: string,
    accessUntil: string,
    reason: string,
    requestId: string,
  ): Promise<{ id: string }> {
    return this.serialized(accountId, async () => {
      const account = await this.env.DB.prepare(
        "SELECT is_suspended FROM accounts WHERE id = ?",
      ).bind(accountId).first<{ is_suspended: number }>();
      if (!account || account.is_suspended === 1) throw new ApiHttpError(409, "conflict", "Account is unavailable.");
      const plan = await this.env.DB.prepare(
        "SELECT id FROM commerce_plans WHERE id = ? AND status = 'published'",
      ).bind(planId).first<{ id: string }>();
      if (!plan) throw new ApiHttpError(400, "validation_error", "A published plan is required.");
      const expiry = Date.parse(accessUntil);
      const now = Date.now();
      if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 5 * 365 * 24 * 60 * 60 * 1000) {
        throw new ApiHttpError(400, "validation_error", "Access expiry must be within five years.");
      }
      const id = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO commerce_subscriptions(id, account_id, plan_id, access_until, reason, granted_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(id, accountId, planId, accessUntil, reason, actorId),
        this.env.DB.prepare(
          `INSERT INTO audit_logs(
             id, actor_account_id, action, entity_type, entity_id, reason, "after", request_id
           ) VALUES (?, ?, 'subscription.grant', 'commerce_subscription', ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), actorId, id, reason,
          JSON.stringify({ id, accountId, planId, accessUntil, status: "active" }), requestId),
        this.env.DB.prepare(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES (?, 'subscription.granted', 'commerce_subscription', ?, ?)`,
        ).bind(eventId, id, JSON.stringify({ subscriptionId: id, accountId })),
      ]);
      return { id };
    });
  }

  async revokeSubscription(
    actorId: string,
    accountId: string,
    subscriptionId: string,
    reason: string,
    requestId: string,
  ): Promise<{ id: string }> {
    return this.serialized(accountId, async () => {
      const current = await this.env.DB.prepare(
        `SELECT id, plan_id, access_until FROM commerce_subscriptions
         WHERE id = ? AND account_id = ? AND status = 'active'`,
      ).bind(subscriptionId, accountId).first<{ id: string; plan_id: string; access_until: string }>();
      if (!current) throw new ApiHttpError(404, "not_found", "Active subscription not found.");
      const now = new Date().toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE commerce_subscriptions SET status = 'revoked', revoked_at = ?, revoked_by = ?
           WHERE id = ? AND account_id = ? AND status = 'active'`,
        ).bind(now, actorId, subscriptionId, accountId),
        this.env.DB.prepare(
          `INSERT INTO audit_logs(
             id, actor_account_id, action, entity_type, entity_id, reason, "before", "after", request_id
           ) VALUES (?, ?, 'subscription.revoke', 'commerce_subscription', ?, ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), actorId, subscriptionId, reason,
          JSON.stringify({ ...current, status: "active" }), JSON.stringify({ ...current, status: "revoked", revokedAt: now }), requestId),
        this.env.DB.prepare(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES (?, 'subscription.revoked', 'commerce_subscription', ?, ?)`,
        ).bind(crypto.randomUUID(), subscriptionId, JSON.stringify({ subscriptionId, accountId })),
      ]);
      return { id: subscriptionId };
    });
  }

  private async serialized<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      await this.bindCoordinatorKey("accountId", accountId);
      return await operation();
    } finally {
      release();
    }
  }

  private async bindCoordinatorKey(storageKey: string, value: string): Promise<void> {
    const stored = await this.ctx.storage.get<string>(storageKey);
    if (stored && stored !== value) throw new Error("coordinator key mismatch");
    if (!stored) await this.ctx.storage.put(storageKey, value);
  }
}

export class PlanCoordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  async createPlan(actorId: string, input: PlanInput, requestId: string): Promise<{ id: string; version: number; status: "draft" }> {
    return this.serialized(input.slug, async () => {
      const version = await this.env.DB.prepare(
        "SELECT coalesce(max(version), 0) + 1 AS version FROM commerce_plans WHERE slug = ?",
      ).bind(input.slug).first<{ version: number }>();
      const id = crypto.randomUUID();
      const nextVersion = version?.version ?? 1;
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO commerce_plans(
             id, slug, version, name, description, currency, price_minor,
             billing_interval, ad_free, max_profiles, features
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, input.slug, nextVersion, input.name, input.description, input.currency,
          input.priceMinor, input.billingInterval, input.adFree ? 1 : 0, input.maxProfiles,
          JSON.stringify(input.features)),
        this.env.DB.prepare(
          `INSERT INTO audit_logs(
             id, actor_account_id, action, entity_type, entity_id, reason, "after", request_id
           ) VALUES (?, ?, 'plan.create', 'commerce_plan', ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), actorId, id, input.reason,
          JSON.stringify({ id, slug: input.slug, version: nextVersion, status: "draft" }), requestId),
        this.env.DB.prepare(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES (?, 'plan.created', 'commerce_plan', ?, ?)`,
        ).bind(crypto.randomUUID(), id, JSON.stringify({ planId: id, slug: input.slug, version: nextVersion })),
      ]);
      return { id, version: nextVersion, status: "draft" };
    });
  }

  async publishPlan(actorId: string, slug: string, planId: string, reason: string, requestId: string): Promise<{ id: string; status: "published" }> {
    return this.serialized(slug, async () => {
      const target = await this.env.DB.prepare(
        "SELECT id, status FROM commerce_plans WHERE id = ? AND slug = ?",
      ).bind(planId, slug).first<{ id: string; status: string }>();
      if (!target || target.status !== "draft") throw new ApiHttpError(409, "conflict", "Only a draft plan can be published.");
      const now = new Date().toISOString();
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE commerce_plans SET status = 'archived', updated_at = ?
           WHERE slug = ? AND status = 'published'`,
        ).bind(now, slug),
        this.env.DB.prepare(
          `UPDATE commerce_plans SET status = 'published', published_at = ?, updated_at = ?
           WHERE id = ? AND slug = ? AND status = 'draft'`,
        ).bind(now, now, planId, slug),
        this.env.DB.prepare(
          `INSERT INTO audit_logs(
             id, actor_account_id, action, entity_type, entity_id, reason, "after", request_id
           ) VALUES (?, ?, 'plan.publish', 'commerce_plan', ?, ?, ?, ?)`,
        ).bind(crypto.randomUUID(), actorId, planId, reason, JSON.stringify({ status: "published", publishedAt: now }), requestId),
        this.env.DB.prepare(
          `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
           VALUES (?, 'plan.published', 'commerce_plan', ?, ?)`,
        ).bind(crypto.randomUUID(), planId, JSON.stringify({ planId, slug })),
      ]);
      return { id: planId, status: "published" };
    });
  }

  private async serialized<T>(slug: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const stored = await this.ctx.storage.get<string>("slug");
      if (stored && stored !== slug) throw new Error("coordinator key mismatch");
      if (!stored) await this.ctx.storage.put("slug", slug);
      return await operation();
    } finally {
      release();
    }
  }
}
