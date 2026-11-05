import type {
  AccountDto,
  CursorPage,
  EntitlementsDto,
  PermissionKey,
  PlanDto,
  ProfileDto,
  ProviderDto,
  RatingDto,
  RoleKey,
  TitleDto,
  TitleRequestDto,
  TranscodeJobDto,
  WatchlistItemDto,
} from "@lumora/api-contract";
import { PERMISSION_KEYS } from "@lumora/api-contract";
import { ApiHttpError, asIsoDate, booleanValue, offsetCursor } from "./http";
import { sha256Hex } from "./security";

const PERMISSION_SET = new Set<string>(PERMISSION_KEYS);

interface AccountRow {
  id: string;
  email: string;
  email_verified: number;
  display_name: string;
  image_url: string | null;
  is_suspended: number;
  created_at: number;
  updated_at: number;
}

interface AuthorizationRow {
  role_key: string;
  permission_key: string | null;
}

interface ProfileRow {
  id: string;
  name: string;
  avatar: string | null;
  maturity_ceiling: string;
  is_kids: number;
  created_at: string;
  updated_at: string;
}

interface TitleRow {
  id: string;
  type: "movie" | "tv";
  slug: string;
  name: string;
  original_name: string | null;
  synopsis: string;
  release_year: number | null;
  runtime_minutes: number | null;
  maturity: string;
  original_language: string;
  poster_url: string | null;
  backdrop_url: string | null;
  trailer_url: string | null;
  featured: number;
  editorial_score: number | null;
  popularity: number | null;
  tmdb_id: number | null;
  imdb_id: string | null;
}

export interface Principal {
  account: AccountDto;
  roleKeys: ReadonlySet<RoleKey>;
  permissions: ReadonlySet<PermissionKey>;
}

export interface CatalogFilters {
  type?: "movie" | "tv";
  query?: string;
  genre?: string;
  sort: "trending" | "newest" | "oldest" | "az" | "score";
  offset: number;
  limit: number;
}

export interface ProviderInput {
  key: string;
  name: string;
  adapter: string;
  enabled: boolean;
  baseUrl?: string | null;
  allowedDomains: string[];
  priority: number;
  timeoutMs: number;
  enabledRegions: string[];
  consentRequired: boolean;
  config: Record<string, unknown>;
  reason: string;
}

export interface ProfileInput {
  name: string;
  avatar?: string | null;
  maturityCeiling?: string;
  isKids?: boolean;
}

export interface ProgressInput {
  episodeId?: string | null;
  positionSeconds: number;
  durationSeconds?: number | null;
  completed?: boolean;
}

export interface TitleCreateInput {
  type: "movie" | "tv";
  slug: string;
  name: string;
  originalName?: string | null;
  synopsis: string;
  releaseYear?: number | null;
  runtimeMinutes?: number | null;
  maturity: string;
  status: "draft" | "scheduled" | "published" | "archived";
  visibility: "public" | "private";
  originalLanguage: string;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  trailerUrl?: string | null;
  featured: boolean;
  editorialScore?: number | null;
  tmdbId?: number | null;
  imdbId?: string | null;
  publishedAt?: string | null;
  reason: string;
}

export class Repository {
  constructor(private readonly db: D1Database) {}

  async principal(accountId: string): Promise<Principal> {
    const account = await this.db.prepare(
      `SELECT id, email, email_verified, display_name, image_url, is_suspended, created_at, updated_at
       FROM accounts WHERE id = ?`,
    ).bind(accountId).first<AccountRow>();
    if (!account) throw new ApiHttpError(401, "unauthorized", "Authentication required.");
    if (account.is_suspended === 1) throw new ApiHttpError(403, "session_suspended", "This account is unavailable.");

    const authorization = await this.db.prepare(
      `SELECT r.key AS role_key, p.key AS permission_key
       FROM account_members am
       JOIN roles r ON r.id = am.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
       WHERE am.account_id = ?`,
    ).bind(accountId).all<AuthorizationRow>();
    const roles = new Set<RoleKey>();
    const permissions = new Set<PermissionKey>();
    for (const row of authorization.results) {
      if (["owner", "admin", "editor", "viewer"].includes(row.role_key)) roles.add(row.role_key as RoleKey);
      if (row.permission_key && PERMISSION_SET.has(row.permission_key)) permissions.add(row.permission_key as PermissionKey);
    }
    return {
      account: mapAccount(account, [...roles], [...permissions]),
      roleKeys: roles,
      permissions,
    };
  }

  async account(accountId: string): Promise<AccountDto> {
    return (await this.principal(accountId)).account;
  }

  async updateAccount(accountId: string, displayName: string): Promise<AccountDto> {
    await this.db.prepare(
      `UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ? AND is_suspended = 0`,
    ).bind(displayName, Date.now(), accountId).run();
    return this.account(accountId);
  }

  async listProfiles(accountId: string): Promise<ProfileDto[]> {
    const result = await this.db.prepare(
      `SELECT id, name, avatar, maturity_ceiling, is_kids, created_at, updated_at
       FROM profiles WHERE account_id = ? ORDER BY created_at, id`,
    ).bind(accountId).all<ProfileRow>();
    return result.results.map(mapProfile);
  }

  async createProfileSerialized(accountId: string, input: ProfileInput): Promise<ProfileDto> {
    const entitlements = await this.entitlements(accountId);
    const count = await this.db.prepare(
      "SELECT count(*) AS count FROM profiles WHERE account_id = ?",
    ).bind(accountId).first<{ count: number }>();
    if ((count?.count ?? 0) >= entitlements.maxProfiles) {
      throw new ApiHttpError(409, "conflict", "The account profile limit has been reached.");
    }

    const id = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const event = outboxEvent(this.db, "profile.created", "profile", id, { accountId, profileId: id });
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO profiles(id, account_id, name, avatar, maturity_ceiling, is_kids)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(id, accountId, input.name, input.avatar ?? null, input.maturityCeiling ?? "TV-MA", input.isKids ? 1 : 0),
        this.db.prepare(
          `INSERT INTO watchlists(id, profile_id, account_id, name, is_default)
           VALUES (?, ?, ?, 'My list', 1)`,
        ).bind(listId, id, accountId),
        event,
      ]);
    } catch (error) {
      throw constraintError(error, "A profile with that name already exists.");
    }
    return this.ownedProfile(accountId, id);
  }

  async updateProfile(accountId: string, profileId: string, input: Partial<ProfileInput>): Promise<ProfileDto> {
    await this.assertProfileOwnership(accountId, profileId);
    const current = await this.ownedProfile(accountId, profileId);
    try {
      await this.db.prepare(
        `UPDATE profiles SET name = ?, avatar = ?, maturity_ceiling = ?, is_kids = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND account_id = ?`,
      ).bind(
        input.name ?? current.name,
        input.avatar === undefined ? current.avatar : input.avatar,
        input.maturityCeiling ?? current.maturityCeiling,
        input.isKids === undefined ? (current.isKids ? 1 : 0) : (input.isKids ? 1 : 0),
        profileId,
        accountId,
      ).run();
    } catch (error) {
      throw constraintError(error, "A profile with that name already exists.");
    }
    return this.ownedProfile(accountId, profileId);
  }

  async deleteProfileSerialized(accountId: string, profileId: string): Promise<void> {
    await this.assertProfileOwnership(accountId, profileId);
    const count = await this.db.prepare(
      "SELECT count(*) AS count FROM profiles WHERE account_id = ?",
    ).bind(accountId).first<{ count: number }>();
    if ((count?.count ?? 0) <= 1) throw new ApiHttpError(409, "conflict", "An account must keep one profile.");
    await this.db.batch([
      this.db.prepare("DELETE FROM profiles WHERE id = ? AND account_id = ?").bind(profileId, accountId),
      outboxEvent(this.db, "profile.deleted", "profile", profileId, { accountId, profileId }),
    ]);
  }

  async ownedProfile(accountId: string, profileId: string): Promise<ProfileDto> {
    const row = await this.db.prepare(
      `SELECT id, name, avatar, maturity_ceiling, is_kids, created_at, updated_at
       FROM profiles WHERE id = ? AND account_id = ?`,
    ).bind(profileId, accountId).first<ProfileRow>();
    if (!row) throw new ApiHttpError(404, "not_found", "Profile not found.");
    return mapProfile(row);
  }

  async assertProfileOwnership(accountId: string, profileId: string): Promise<void> {
    const row = await this.db.prepare(
      "SELECT 1 AS owned FROM profiles WHERE id = ? AND account_id = ?",
    ).bind(profileId, accountId).first<{ owned: number }>();
    if (!row) throw new ApiHttpError(404, "not_found", "Profile not found.");
  }

  async listWatchlist(accountId: string, profileId: string, offset: number, limit: number): Promise<CursorPage<WatchlistItemDto>> {
    await this.assertProfileOwnership(accountId, profileId);
    const rows = await this.db.prepare(
      `SELECT t.id, t.type, t.slug, t.name, t.original_name, t.synopsis, t.release_year,
              t.runtime_minutes, t.maturity, t.original_language, t.poster_url, t.backdrop_url,
              t.trailer_url, t.featured, t.editorial_score, t.popularity, t.tmdb_id, t.imdb_id,
              wi.sort_order, wi.added_at
       FROM watchlists w
       JOIN watchlist_items wi ON wi.watchlist_id = w.id
       JOIN titles t ON t.id = wi.title_id
       WHERE w.profile_id = ? AND w.account_id = ? AND w.is_default = 1
       ORDER BY wi.sort_order, wi.added_at DESC, t.id
       LIMIT ? OFFSET ?`,
    ).bind(profileId, accountId, limit + 1, offset).all<TitleRow & { sort_order: number; added_at: string }>();
    const pageRows = rows.results.slice(0, limit);
    const genres = await this.genresForTitles(pageRows.map((row) => row.id));
    return {
      data: pageRows.map((row) => ({
        title: mapTitle(row, genres.get(row.id) ?? []),
        sortOrder: row.sort_order,
        addedAt: row.added_at,
      })),
      page: { nextCursor: rows.results.length > limit ? offsetCursor(offset + limit) : null, limit },
    };
  }

  async addWatchlistTitle(accountId: string, profileId: string, titleId: string): Promise<{ addedAt: string }> {
    await this.assertProfileOwnership(accountId, profileId);
    await this.assertPublicTitle(titleId);
    const watchlist = await this.db.prepare(
      "SELECT id FROM watchlists WHERE profile_id = ? AND account_id = ? AND is_default = 1",
    ).bind(profileId, accountId).first<{ id: string }>();
    if (!watchlist) throw new ApiHttpError(409, "conflict", "Default watchlist is unavailable.");
    await this.db.prepare(
      `INSERT INTO watchlist_items(watchlist_id, title_id) VALUES (?, ?)
       ON CONFLICT(watchlist_id, title_id) DO UPDATE SET added_at = excluded.added_at`,
    ).bind(watchlist.id, titleId).run();
    const row = await this.db.prepare(
      "SELECT added_at FROM watchlist_items WHERE watchlist_id = ? AND title_id = ?",
    ).bind(watchlist.id, titleId).first<{ added_at: string }>();
    return { addedAt: row?.added_at ?? new Date().toISOString() };
  }

  async removeWatchlistTitle(accountId: string, profileId: string, titleId: string): Promise<void> {
    await this.assertProfileOwnership(accountId, profileId);
    await this.db.prepare(
      `DELETE FROM watchlist_items WHERE title_id = ? AND watchlist_id IN
       (SELECT id FROM watchlists WHERE profile_id = ? AND account_id = ? AND is_default = 1)`,
    ).bind(titleId, profileId, accountId).run();
  }

  async listProgress(accountId: string, profileId: string, offset: number, limit: number) {
    await this.assertProfileOwnership(accountId, profileId);
    const result = await this.db.prepare(
      `SELECT id, profile_id, title_id, episode_id, position_seconds, duration_seconds,
              progress, completed, updated_at
       FROM watch_progress WHERE account_id = ? AND profile_id = ?
       ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`,
    ).bind(accountId, profileId, limit + 1, offset).all<{
      id: string; profile_id: string; title_id: string; episode_id: string | null;
      position_seconds: number; duration_seconds: number | null; progress: number;
      completed: number; updated_at: string;
    }>();
    return {
      data: result.results.slice(0, limit).map((row) => ({
        id: row.id,
        profileId: row.profile_id,
        titleId: row.title_id,
        episodeId: row.episode_id,
        positionSeconds: row.position_seconds,
        durationSeconds: row.duration_seconds,
        progress: row.progress,
        completed: booleanValue(row.completed),
        updatedAt: row.updated_at,
      })),
      page: { nextCursor: result.results.length > limit ? offsetCursor(offset + limit) : null, limit },
    };
  }

  async putProgress(accountId: string, profileId: string, titleId: string, input: ProgressInput) {
    await this.assertProfileOwnership(accountId, profileId);
    await this.assertPublicTitle(titleId);
    if (input.episodeId) await this.assertEpisodeForTitle(input.episodeId, titleId);
    const duration = input.durationSeconds ?? null;
    const progress = duration && duration > 0 ? Math.min(1, input.positionSeconds / duration) : 0;
    const completed = input.completed ?? progress >= 0.95;
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO watch_progress(
         id, profile_id, account_id, title_id, episode_id, position_seconds,
         duration_seconds, progress, completed
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         position_seconds = excluded.position_seconds,
         duration_seconds = excluded.duration_seconds,
         progress = excluded.progress,
         completed = excluded.completed,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(id, profileId, accountId, titleId, input.episodeId ?? null, input.positionSeconds, duration, progress, completed ? 1 : 0).run();
    return this.db.prepare(
      `SELECT id, profile_id, title_id, episode_id, position_seconds, duration_seconds,
              progress, completed, updated_at
       FROM watch_progress WHERE profile_id = ? AND title_id = ? AND episode_id IS ?`,
    ).bind(profileId, titleId, input.episodeId ?? null).first();
  }

  async putRating(accountId: string, profileId: string, titleId: string, value: number): Promise<RatingDto> {
    await this.assertProfileOwnership(accountId, profileId);
    await this.assertPublicTitle(titleId);
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO ratings(id, profile_id, account_id, title_id, value)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, title_id) DO UPDATE SET
         value = excluded.value,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(id, profileId, accountId, titleId, value).run();
    const row = await this.db.prepare(
      "SELECT id, profile_id, title_id, value, updated_at FROM ratings WHERE profile_id = ? AND title_id = ?",
    ).bind(profileId, titleId).first<{ id: string; profile_id: string; title_id: string; value: number; updated_at: string }>();
    if (!row) throw new Error("rating write did not return a row");
    return { id: row.id, profileId: row.profile_id, titleId: row.title_id, value: row.value, updatedAt: row.updated_at };
  }

  async deleteRating(accountId: string, profileId: string, titleId: string): Promise<void> {
    await this.assertProfileOwnership(accountId, profileId);
    await this.db.prepare(
      "DELETE FROM ratings WHERE account_id = ? AND profile_id = ? AND title_id = ?",
    ).bind(accountId, profileId, titleId).run();
  }

  async listPublicTitles(filters: CatalogFilters): Promise<CursorPage<TitleDto>> {
    const clauses = [
      "t.status = 'published'",
      "t.visibility = 'public'",
      "(t.published_at IS NULL OR t.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    ];
    const bindings: unknown[] = [];
    let join = "";
    if (filters.type) {
      clauses.push("t.type = ?");
      bindings.push(filters.type);
    }
    if (filters.genre) {
      join += " JOIN title_genres filter_tg ON filter_tg.title_id = t.id JOIN genres filter_g ON filter_g.id = filter_tg.genre_id";
      clauses.push("lower(filter_g.name) = lower(?)");
      bindings.push(filters.genre);
    }
    if (filters.query) {
      join += " JOIN titles_fts ON titles_fts.title_id = t.id";
      clauses.push("titles_fts MATCH ?");
      bindings.push(ftsQuery(filters.query));
    }
    const order = {
      trending: "t.popularity DESC NULLS LAST, t.editorial_score DESC NULLS LAST, t.id",
      newest: "t.release_year DESC NULLS LAST, t.id",
      oldest: "t.release_year ASC NULLS LAST, t.id",
      az: "t.name COLLATE NOCASE, t.id",
      score: "t.editorial_score DESC NULLS LAST, t.id",
    }[filters.sort];
    bindings.push(filters.limit + 1, filters.offset);
    const result = await this.db.prepare(
      `SELECT DISTINCT t.id, t.type, t.slug, t.name, t.original_name, t.synopsis,
              t.release_year, t.runtime_minutes, t.maturity, t.original_language,
              t.poster_url, t.backdrop_url, t.trailer_url, t.featured,
              t.editorial_score, t.popularity, t.tmdb_id, t.imdb_id
       FROM titles t${join}
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
    ).bind(...bindings).all<TitleRow>();
    const pageRows = result.results.slice(0, filters.limit);
    const genres = await this.genresForTitles(pageRows.map((row) => row.id));
    return {
      data: pageRows.map((row) => mapTitle(row, genres.get(row.id) ?? [])),
      page: {
        nextCursor: result.results.length > filters.limit ? offsetCursor(filters.offset + filters.limit) : null,
        limit: filters.limit,
      },
    };
  }

  async publicTitle(titleId: string): Promise<TitleDto> {
    const row = await this.db.prepare(
      `SELECT id, type, slug, name, original_name, synopsis, release_year, runtime_minutes,
              maturity, original_language, poster_url, backdrop_url, trailer_url, featured,
              editorial_score, popularity, tmdb_id, imdb_id
       FROM titles
       WHERE id = ? AND status = 'published' AND visibility = 'public'
         AND (published_at IS NULL OR published_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).bind(titleId).first<TitleRow>();
    if (!row) throw new ApiHttpError(404, "not_found", "Title not found.");
    const genres = await this.genresForTitles([titleId]);
    return mapTitle(row, genres.get(titleId) ?? []);
  }

  async listGenres(): Promise<Array<{ id: string; slug: string; name: string }>> {
    const rows = await this.db.prepare("SELECT id, slug, name FROM genres ORDER BY name COLLATE NOCASE, id").all<{
      id: string; slug: string; name: string;
    }>();
    return rows.results;
  }

  async playbackSources(titleId: string, episodeId: string | null) {
    await this.assertPublicTitle(titleId);
    if (episodeId) await this.assertEpisodeForTitle(episodeId, titleId);
    const rows = await this.db.prepare(
      `SELECT ms.id, ms.kind, ms.reference, ms.label, ms.consent_required
       FROM media_sources ms
       WHERE ms.title_id = ? AND ms.episode_id IS ? AND ms.enabled = 1
       ORDER BY ms.is_default DESC, ms.priority, ms.id
       LIMIT 20`,
    ).bind(titleId, episodeId).all<{
      id: string; kind: string; reference: string | null; label: string; consent_required: number;
    }>();
    return rows.results.map((row, index) => ({
      sourceId: row.id,
      id: `server-${index + 1}`,
      label: row.reference?.startsWith("media/") ? "Direct" : `Server ${index + 1}`,
      kind: row.kind,
      reference: row.reference,
      consentRequired: booleanValue(row.consent_required),
    }));
  }

  async createPlaybackSession(accountId: string, input: {
    profileId?: string | null; titleId: string; episodeId?: string | null;
    sourceId?: string | null; device?: string | null; state?: string;
  }) {
    if (input.profileId) await this.assertProfileOwnership(accountId, input.profileId);
    await this.assertPublicTitle(input.titleId);
    if (input.episodeId) await this.assertEpisodeForTitle(input.episodeId, input.titleId);
    const id = crypto.randomUUID();
    await this.db.prepare(
      `INSERT INTO playback_sessions(id, account_id, profile_id, title_id, episode_id, source_id, device, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, accountId, input.profileId ?? null, input.titleId, input.episodeId ?? null,
      input.sourceId ?? null, input.device ?? null, input.state ?? "idle").run();
    return this.db.prepare(
      `SELECT id, profile_id AS profileId, title_id AS titleId, episode_id AS episodeId,
              source_id AS sourceId, device, state, started_at AS startedAt
       FROM playback_sessions WHERE id = ? AND account_id = ?`,
    ).bind(id, accountId).first();
  }

  async listRequests(accountId: string, offset: number, limit: number, allAccounts: boolean): Promise<CursorPage<TitleRequestDto>> {
    const where = allAccounts ? "1 = 1" : "account_id = ?";
    const bindings: unknown[] = allAccounts ? [] : [accountId];
    bindings.push(limit + 1, offset);
    const rows = await this.db.prepare(
      `SELECT id, title_name, media_type, year, note, status, created_at, updated_at
       FROM title_requests WHERE ${where}
       ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    ).bind(...bindings).all<{
      id: string; title_name: string; media_type: "movie" | "tv"; year: number | null;
      note: string | null; status: "pending" | "imported" | "rejected";
      created_at: string; updated_at: string;
    }>();
    return {
      data: rows.results.slice(0, limit).map((row) => ({
        id: row.id,
        titleName: row.title_name,
        mediaType: row.media_type,
        year: row.year,
        note: row.note,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      page: { nextCursor: rows.results.length > limit ? offsetCursor(offset + limit) : null, limit },
    };
  }

  async createRequest(accountId: string, input: {
    titleName: string; mediaType: "movie" | "tv"; year?: number | null; note?: string | null;
  }): Promise<TitleRequestDto> {
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO title_requests(id, account_id, title_name, media_type, year, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, accountId, input.titleName, input.mediaType, input.year ?? null, input.note ?? null),
      outboxEvent(this.db, "title_request.created", "title_request", id, { requestId: id }),
    ]);
    const page = await this.listRequests(accountId, 0, 1, false);
    const created = page.data.find((request) => request.id === id);
    if (created) return created;
    const row = await this.db.prepare(
      `SELECT id, title_name, media_type, year, note, status, created_at, updated_at
       FROM title_requests WHERE id = ? AND account_id = ?`,
    ).bind(id, accountId).first<{
      id: string; title_name: string; media_type: "movie" | "tv"; year: number | null;
      note: string | null; status: "pending" | "imported" | "rejected";
      created_at: string; updated_at: string;
    }>();
    if (!row) throw new Error("title request write did not return a row");
    return {
      id: row.id, titleName: row.title_name, mediaType: row.media_type, year: row.year,
      note: row.note, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async createPlaybackReport(accountId: string | null, input: {
    titleId?: string | null; episodeId?: string | null; serverLabel?: string | null;
    playerState?: string | null; message?: string | null;
  }): Promise<{ accepted: true; id: string }> {
    const id = crypto.randomUUID();
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO playback_reports(id, account_id, title_id, episode_id, server_label, player_state, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, accountId, input.titleId ?? null, input.episodeId ?? null, input.serverLabel ?? null,
        input.playerState ?? null, input.message ?? null),
      outboxEvent(this.db, "playback_report.created", "playback_report", id, { reportId: id }),
    ]);
    return { accepted: true, id };
  }

  async listPublicPlans(): Promise<PlanDto[]> {
    const rows = await this.db.prepare(
      `SELECT id, slug, version, name, description, currency, price_minor, billing_interval,
              ad_free, max_profiles, features, status, published_at
       FROM commerce_plans WHERE status = 'published' ORDER BY price_minor, slug, version DESC`,
    ).all<PlanRow>();
    return rows.results.map(mapPlan);
  }

  async planSlug(planId: string): Promise<string> {
    const row = await this.db.prepare("SELECT slug FROM commerce_plans WHERE id = ?")
      .bind(planId).first<{ slug: string }>();
    if (!row) throw new ApiHttpError(404, "not_found", "Plan not found.");
    return row.slug;
  }

  async subscriptionAccountId(subscriptionId: string): Promise<string> {
    const row = await this.db.prepare("SELECT account_id FROM commerce_subscriptions WHERE id = ?")
      .bind(subscriptionId).first<{ account_id: string }>();
    if (!row) throw new ApiHttpError(404, "not_found", "Subscription not found.");
    return row.account_id;
  }

  async entitlements(accountId: string | null): Promise<EntitlementsDto> {
    if (!accountId) return { resolved: true, adFree: false, maxProfiles: 1, status: "free" };
    const account = await this.db.prepare("SELECT is_suspended FROM accounts WHERE id = ?").bind(accountId)
      .first<{ is_suspended: number }>();
    if (!account || account.is_suspended === 1) {
      return { resolved: false, adFree: false, maxProfiles: 1, status: "unavailable" };
    }
    const active = await this.db.prepare(
      `SELECT p.id, p.name, p.ad_free, p.max_profiles, s.access_until
       FROM commerce_subscriptions s JOIN commerce_plans p ON p.id = s.plan_id
       WHERE s.account_id = ? AND s.status = 'active'
         AND s.starts_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND s.access_until > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY p.ad_free DESC, p.max_profiles DESC, s.access_until DESC, s.id LIMIT 1`,
    ).bind(accountId).first<{ id: string; name: string; ad_free: number; max_profiles: number; access_until: string }>();
    if (active) {
      return {
        resolved: true,
        adFree: booleanValue(active.ad_free),
        maxProfiles: active.max_profiles,
        status: "active",
        planId: active.id,
        planName: active.name,
        accessUntil: active.access_until,
      };
    }
    const expired = await this.db.prepare(
      `SELECT max(access_until) AS access_until FROM commerce_subscriptions
       WHERE account_id = ? AND access_until <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(accountId).first<{ access_until: string | null }>();
    return {
      resolved: true,
      adFree: false,
      maxProfiles: 1,
      status: expired?.access_until ? "expired" : "free",
      ...(expired?.access_until ? { accessUntil: expired.access_until } : {}),
    };
  }

  async listProviders(): Promise<ProviderDto[]> {
    const rows = await this.db.prepare(
      `SELECT id, key, name, adapter, enabled, priority, timeout_ms, health, updated_at
       FROM providers ORDER BY priority, key LIMIT 100`,
    ).all<{
      id: string; key: string; name: string; adapter: string; enabled: number;
      priority: number; timeout_ms: number; health: ProviderDto["health"]; updated_at: string;
    }>();
    return rows.results.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      adapter: row.adapter,
      enabled: booleanValue(row.enabled),
      priority: row.priority,
      timeoutMs: row.timeout_ms,
      health: row.health,
      updatedAt: row.updated_at,
    }));
  }

  async createProvider(actorId: string, input: ProviderInput, requestId: string): Promise<ProviderDto> {
    const id = crypto.randomUUID();
    const after = redactedProvider(input);
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO providers(
             id, key, name, adapter, enabled, base_url, allowed_domains, priority,
             timeout_ms, enabled_regions, consent_required, config, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, input.key, input.name, input.adapter, input.enabled ? 1 : 0, input.baseUrl ?? null,
          JSON.stringify(input.allowedDomains), input.priority, input.timeoutMs, JSON.stringify(input.enabledRegions),
          input.consentRequired ? 1 : 0, JSON.stringify(input.config), actorId),
        auditStatement(this.db, actorId, "provider.create", "provider", id, input.reason, null, after, requestId),
        outboxEvent(this.db, "provider.created", "provider", id, { providerId: id }),
      ]);
    } catch (error) {
      throw constraintError(error, "A provider with that key already exists.");
    }
    const providers = await this.listProviders();
    const provider = providers.find((value) => value.id === id);
    if (!provider) throw new Error("provider write did not return a row");
    return provider;
  }

  async publicSettings() {
    const settings = await this.db.prepare(
      "SELECT key, value, description, updated_at FROM site_settings WHERE is_public = 1 ORDER BY key LIMIT 100",
    ).all<{ key: string; value: string; description: string; updated_at: string }>();
    const flags = await this.db.prepare(
      "SELECT key, enabled, rollout, description, updated_at FROM feature_flags WHERE is_public = 1 ORDER BY key LIMIT 100",
    ).all<{ key: string; enabled: number; rollout: string; description: string; updated_at: string }>();
    return {
      settings: settings.results.map((row) => ({ ...row, value: JSON.parse(row.value) as unknown })),
      featureFlags: flags.results.map((row) => ({
        key: row.key,
        enabled: booleanValue(row.enabled),
        rollout: JSON.parse(row.rollout) as unknown,
        description: row.description,
        updatedAt: row.updated_at,
      })),
    };
  }

  async saveSetting(actorId: string, key: string, input: {
    value: unknown; isPublic: boolean; description: string; reason: string;
  }, requestId: string) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/u.test(key)) {
      throw new ApiHttpError(400, "validation_error", "Invalid setting key.");
    }
    if (key === "playback_vast") throw new ApiHttpError(403, "forbidden", "VAST settings require the ads service.");
    const before = await this.db.prepare("SELECT value, is_public, description FROM site_settings WHERE key = ?")
      .bind(key).first<{ value: string; is_public: number; description: string }>();
    const value = JSON.stringify(input.value);
    if (value.length > 50_000) throw new ApiHttpError(400, "validation_error", "Setting value is too large.");
    const after = { value: input.value, isPublic: input.isPublic, description: input.description };
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO site_settings(key, value, is_public, description, updated_by)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_public = excluded.is_public,
           description = excluded.description, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(key, value, input.isPublic ? 1 : 0, input.description, actorId),
      auditStatement(this.db, actorId, "setting.update", "site_setting", key, input.reason,
        before ? { value: JSON.parse(before.value) as unknown, isPublic: booleanValue(before.is_public), description: before.description } : null,
        after, requestId),
      outboxEvent(this.db, "setting.updated", "site_setting", key, { key }),
    ]);
    return after;
  }

  async saveVastSettings(actorId: string, input: {
    enabled: boolean;
    tagUrl: string;
    allowedHosts: string[];
    firstBreakSeconds: number;
    intervalSeconds: number;
    maxBreaks: number;
    allowSkip: boolean;
    skipAfterSeconds: number;
    reason: string;
  }, requestId: string) {
    const before = await this.db.prepare("SELECT value FROM site_settings WHERE key = 'playback_vast'")
      .first<{ value: string }>();
    const stored = {
      enabled: input.enabled,
      tagUrl: input.tagUrl,
      allowedHosts: input.allowedHosts.map((host) => host.toLowerCase()),
      firstBreakSeconds: input.firstBreakSeconds,
      intervalSeconds: input.intervalSeconds,
      maxBreaks: input.maxBreaks,
      allowSkip: input.allowSkip,
      skipAfterSeconds: input.skipAfterSeconds,
    };
    const redacted = redactVast(stored);
    const redactedBefore = before ? redactVast(JSON.parse(before.value) as Record<string, unknown>) : null;
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO site_settings(key, value, is_public, description, updated_by)
         VALUES ('playback_vast', ?, 0, 'Private VAST provider configuration; audited ads.manage writes only', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, is_public = 0,
           description = excluded.description, updated_by = excluded.updated_by,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(JSON.stringify(stored), actorId),
      auditStatement(this.db, actorId, "ads.vast.update", "site_setting", "playback_vast", input.reason,
        redactedBefore, redacted, requestId),
      outboxEvent(this.db, "ads.vast.updated", "site_setting", "playback_vast", { enabled: input.enabled }),
    ]);
    return redacted;
  }

  async listAccounts(offset: number, limit: number): Promise<CursorPage<AccountDto>> {
    const rows = await this.db.prepare(
      `SELECT id, email, email_verified, display_name, image_url, is_suspended, created_at, updated_at
       FROM accounts ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    ).bind(limit + 1, offset).all<AccountRow>();
    const data: AccountDto[] = [];
    for (const row of rows.results.slice(0, limit)) {
      const authorization = await this.authorizationForAccount(row.id);
      data.push(mapAccount(row, authorization.roles, authorization.permissions));
    }
    return { data, page: { nextCursor: rows.results.length > limit ? offsetCursor(offset + limit) : null, limit } };
  }

  async setSuspension(actorId: string, accountId: string, suspended: boolean, reason: string, requestId: string): Promise<AccountDto> {
    if (actorId === accountId && suspended) throw new ApiHttpError(409, "conflict", "Self-suspension is not allowed.");
    const before = await this.db.prepare(
      "SELECT is_suspended FROM accounts WHERE id = ?",
    ).bind(accountId).first<{ is_suspended: number }>();
    if (!before) throw new ApiHttpError(404, "not_found", "Account not found.");
    await this.db.batch([
      this.db.prepare("UPDATE accounts SET is_suspended = ?, updated_at = ? WHERE id = ?")
        .bind(suspended ? 1 : 0, Date.now(), accountId),
      this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").bind(accountId),
      auditStatement(this.db, actorId, suspended ? "account.suspend" : "account.unsuspend", "account", accountId,
        reason, { isSuspended: booleanValue(before.is_suspended) }, { isSuspended: suspended }, requestId),
      outboxEvent(this.db, suspended ? "account.suspended" : "account.unsuspended", "account", accountId, { accountId }),
    ]);
    const account = await this.accountRegardlessOfSuspension(accountId);
    return account;
  }

  async listAudit(offset: number, limit: number) {
    const rows = await this.db.prepare(
      `SELECT id, actor_account_id, action, entity_type, entity_id, reason, outcome,
              "before", "after", request_id, created_at
       FROM audit_logs ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    ).bind(limit + 1, offset).all<{
      id: string; actor_account_id: string | null; action: string; entity_type: string | null;
      entity_id: string | null; reason: string | null; outcome: "success" | "failure";
      before: string | null; after: string | null; request_id: string | null; created_at: string;
    }>();
    return {
      data: rows.results.slice(0, limit).map((row) => ({
        id: row.id,
        actorAccountId: row.actor_account_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        reason: row.reason,
        outcome: row.outcome,
        before: row.before ? JSON.parse(row.before) as unknown : null,
        after: row.after ? JSON.parse(row.after) as unknown : null,
        requestId: row.request_id,
        createdAt: row.created_at,
      })),
      page: { nextCursor: rows.results.length > limit ? offsetCursor(offset + limit) : null, limit },
    };
  }

  async createTitle(actorId: string, input: TitleCreateInput, requestId: string): Promise<TitleDto> {
    const id = crypto.randomUUID();
    if (input.status === "published" && !input.publishedAt) input.publishedAt = new Date().toISOString();
    try {
      await this.db.batch([
        this.db.prepare(
          `INSERT INTO titles(
             id, type, slug, name, original_name, synopsis, release_year, runtime_minutes,
             maturity, status, visibility, original_language, poster_url, backdrop_url,
             trailer_url, featured, editorial_score, tmdb_id, imdb_id, published_at, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, input.type, input.slug, input.name, input.originalName ?? null, input.synopsis,
          input.releaseYear ?? null, input.runtimeMinutes ?? null, input.maturity, input.status,
          input.visibility, input.originalLanguage, input.posterUrl ?? null, input.backdropUrl ?? null,
          input.trailerUrl ?? null, input.featured ? 1 : 0, input.editorialScore ?? null,
          input.tmdbId ?? null, input.imdbId ?? null, input.publishedAt ?? null, actorId),
        auditStatement(this.db, actorId, "catalog.create", "title", id, input.reason, null,
          { id, type: input.type, slug: input.slug, name: input.name, status: input.status, visibility: input.visibility }, requestId),
        outboxEvent(this.db, "catalog.title.created", "title", id, { titleId: id }),
      ]);
    } catch (error) {
      throw constraintError(error, "A title with that slug or external ID already exists.");
    }
    if (input.status === "published" && input.visibility === "public") return this.publicTitle(id);
    const row = await this.db.prepare(
      `SELECT id, type, slug, name, original_name, synopsis, release_year, runtime_minutes,
              maturity, original_language, poster_url, backdrop_url, trailer_url, featured,
              editorial_score, popularity, tmdb_id, imdb_id FROM titles WHERE id = ?`,
    ).bind(id).first<TitleRow>();
    if (!row) throw new Error("title write did not return a row");
    return mapTitle(row, []);
  }

  async createTranscodeJob(
    actorId: string,
    input: { inputKey: string; outputPrefix: string; preset: TranscodeJobDto["preset"]; reason: string },
    idempotencyKey: string,
    requestId: string,
  ): Promise<TranscodeJobDto> {
    const requestHash = await sha256Hex(JSON.stringify({
      inputKey: input.inputKey,
      outputPrefix: input.outputPrefix,
      preset: input.preset,
    }));
    const existing = await this.idempotentResponse(actorId, "transcode.create", idempotencyKey, requestHash);
    if (existing) return existing as TranscodeJobDto;

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const response: TranscodeJobDto = {
      id,
      inputKey: input.inputKey,
      outputPrefix: input.outputPrefix,
      preset: input.preset,
      status: "queued",
      createdAt,
    };
    const statements = [
      this.db.prepare(
        `INSERT INTO api_idempotency(
           account_id, scope, key, request_hash, response_json, status, expires_at
         ) VALUES (?, 'transcode.create', ?, ?, ?, 202, unixepoch() + 86400)`,
      ).bind(actorId, idempotencyKey, requestHash, JSON.stringify(response)),
      this.db.prepare(
        `INSERT INTO transcode_jobs(id, input_key, output_prefix, preset, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, input.inputKey, input.outputPrefix, input.preset, actorId, createdAt, createdAt),
      auditStatement(this.db, actorId, "transcode.queue", "transcode_job", id, input.reason, null,
        { id, inputKey: input.inputKey, outputPrefix: input.outputPrefix, preset: input.preset, status: "queued" }, requestId),
      outboxEvent(this.db, "transcode.requested", "transcode_job", id, {
        jobId: id,
        inputKey: input.inputKey,
        outputPrefix: input.outputPrefix,
        preset: input.preset,
      }),
    ];
    try {
      await this.db.batch(statements);
      return response;
    } catch (error) {
      const replay = await this.idempotentResponse(actorId, "transcode.create", idempotencyKey, requestHash);
      if (replay) return replay as TranscodeJobDto;
      throw constraintError(error, "Idempotency key was already used.");
    }
  }

  async pendingOutbox(limit = 25) {
    const rows = await this.db.prepare(
      `SELECT id, topic, payload, attempts, created_at FROM outbox_events
       WHERE published_at IS NULL AND available_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       ORDER BY created_at, id LIMIT ?`,
    ).bind(Math.min(limit, 50)).all<{
      id: string; topic: string; payload: string; attempts: number; created_at: string;
    }>();
    return rows.results.map((row) => ({
      id: row.id,
      topic: row.topic,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      attempt: row.attempts + 1,
      createdAt: row.created_at,
    }));
  }

  async markOutboxPublished(id: string): Promise<void> {
    await this.db.prepare(
      `UPDATE outbox_events SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), attempts = attempts + 1
       WHERE id = ? AND published_at IS NULL`,
    ).bind(id).run();
  }

  async markOutboxFailed(id: string): Promise<void> {
    await this.db.prepare(
      `UPDATE outbox_events SET attempts = attempts + 1, last_error = 'queue publish failed',
       available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
       WHERE id = ? AND published_at IS NULL`,
    ).bind(id).run();
  }

  async claimProcessedEvent(consumer: string, eventId: string): Promise<boolean> {
    const result = await this.db.prepare(
      "INSERT OR IGNORE INTO processed_events(consumer, event_id) VALUES (?, ?)",
    ).bind(consumer, eventId).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async releaseProcessedEvent(consumer: string, eventId: string): Promise<void> {
    await this.db.prepare("DELETE FROM processed_events WHERE consumer = ? AND event_id = ?")
      .bind(consumer, eventId).run();
  }

  private async accountRegardlessOfSuspension(accountId: string): Promise<AccountDto> {
    const row = await this.db.prepare(
      `SELECT id, email, email_verified, display_name, image_url, is_suspended, created_at, updated_at
       FROM accounts WHERE id = ?`,
    ).bind(accountId).first<AccountRow>();
    if (!row) throw new ApiHttpError(404, "not_found", "Account not found.");
    const authorization = await this.authorizationForAccount(accountId);
    return mapAccount(row, authorization.roles, authorization.permissions);
  }

  private async idempotentResponse(
    accountId: string,
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<unknown | null> {
    const row = await this.db.prepare(
      `SELECT request_hash, response_json FROM api_idempotency
       WHERE account_id = ? AND scope = ? AND key = ? AND expires_at > unixepoch()`,
    ).bind(accountId, scope, key).first<{ request_hash: string; response_json: string }>();
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new ApiHttpError(409, "conflict", "Idempotency key was used for a different request.");
    }
    return JSON.parse(row.response_json) as unknown;
  }

  private async authorizationForAccount(accountId: string): Promise<{ roles: RoleKey[]; permissions: PermissionKey[] }> {
    const rows = await this.db.prepare(
      `SELECT r.key AS role_key, p.key AS permission_key
       FROM account_members am JOIN roles r ON r.id = am.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id WHERE am.account_id = ?`,
    ).bind(accountId).all<AuthorizationRow>();
    const roles = new Set<RoleKey>();
    const permissions = new Set<PermissionKey>();
    for (const row of rows.results) {
      if (["owner", "admin", "editor", "viewer"].includes(row.role_key)) roles.add(row.role_key as RoleKey);
      if (row.permission_key && PERMISSION_SET.has(row.permission_key)) permissions.add(row.permission_key as PermissionKey);
    }
    return { roles: [...roles], permissions: [...permissions] };
  }

  private async assertPublicTitle(titleId: string): Promise<void> {
    const row = await this.db.prepare(
      `SELECT 1 AS available FROM titles WHERE id = ? AND status = 'published' AND visibility = 'public'
       AND (published_at IS NULL OR published_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).bind(titleId).first<{ available: number }>();
    if (!row) throw new ApiHttpError(404, "not_found", "Title not found.");
  }

  private async assertEpisodeForTitle(episodeId: string, titleId: string): Promise<void> {
    const row = await this.db.prepare(
      "SELECT 1 AS available FROM episodes WHERE id = ? AND title_id = ?",
    ).bind(episodeId, titleId).first<{ available: number }>();
    if (!row) throw new ApiHttpError(400, "validation_error", "Episode does not belong to the title.");
  }

  private async genresForTitles(titleIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (titleIds.length === 0) return result;
    if (titleIds.length > 50) throw new Error("title genre lookup exceeded bind limit");
    const placeholders = titleIds.map(() => "?").join(",");
    const rows = await this.db.prepare(
      `SELECT tg.title_id, g.name FROM title_genres tg JOIN genres g ON g.id = tg.genre_id
       WHERE tg.title_id IN (${placeholders}) ORDER BY g.name COLLATE NOCASE`,
    ).bind(...titleIds).all<{ title_id: string; name: string }>();
    for (const row of rows.results) {
      const list = result.get(row.title_id) ?? [];
      list.push(row.name);
      result.set(row.title_id, list);
    }
    return result;
  }
}

interface PlanRow {
  id: string;
  slug: string;
  version: number;
  name: string;
  description: string;
  currency: string;
  price_minor: number;
  billing_interval: PlanDto["billingInterval"];
  ad_free: number;
  max_profiles: number;
  features: string;
  status: PlanDto["status"];
  published_at: string | null;
}

export function mapPlan(row: PlanRow): PlanDto {
  return {
    id: row.id,
    slug: row.slug,
    version: row.version,
    name: row.name,
    description: row.description,
    currency: row.currency,
    priceMinor: row.price_minor,
    billingInterval: row.billing_interval,
    adFree: booleanValue(row.ad_free),
    maxProfiles: row.max_profiles,
    features: JSON.parse(row.features) as PlanDto["features"],
    status: row.status,
    publishedAt: row.published_at,
  };
}

function mapAccount(row: AccountRow, roles: RoleKey[], permissions: PermissionKey[]): AccountDto {
  return {
    id: row.id,
    email: row.email,
    emailVerified: booleanValue(row.email_verified),
    displayName: row.display_name,
    imageUrl: row.image_url,
    isSuspended: booleanValue(row.is_suspended),
    roles,
    permissions,
    createdAt: asIsoDate(row.created_at),
    updatedAt: asIsoDate(row.updated_at),
  };
}

function mapProfile(row: ProfileRow): ProfileDto {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    maturityCeiling: row.maturity_ceiling,
    isKids: booleanValue(row.is_kids),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTitle(row: TitleRow, genres: string[]): TitleDto {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    ...(row.original_name ? { originalName: row.original_name } : {}),
    synopsis: row.synopsis,
    releaseYear: row.release_year,
    runtimeMinutes: row.runtime_minutes,
    maturity: row.maturity,
    genres,
    originalLanguage: row.original_language,
    posterUrl: row.poster_url,
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    featured: booleanValue(row.featured),
    score: row.editorial_score,
    popularity: row.popularity,
    tmdbId: row.tmdb_id === null ? null : String(row.tmdb_id),
    imdbId: row.imdb_id,
  };
}

function ftsQuery(value: string): string {
  const tokens = value.normalize("NFKC").split(/\s+/u)
    .map((token) => token.replace(/["*:^(){}[\]]/gu, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  if (tokens.length === 0) throw new ApiHttpError(400, "validation_error", "Search query has no searchable terms.");
  return tokens.map((token) => `"${token}"*`).join(" AND ");
}

function constraintError(error: unknown, message: string): ApiHttpError {
  if (error instanceof Error && /(?:constraint|unique)/iu.test(error.message)) {
    return new ApiHttpError(409, "conflict", message);
  }
  throw error;
}

function outboxEvent(
  db: D1Database,
  topic: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO outbox_events(id, topic, aggregate_type, aggregate_id, payload)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), topic, aggregateType, aggregateId, JSON.stringify(payload));
}

function auditStatement(
  db: D1Database,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  reason: string,
  before: unknown,
  after: unknown,
  requestId: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_logs(
       id, actor_account_id, action, entity_type, entity_id, reason, "before", "after", request_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), actorId, action, entityType, entityId, reason,
    before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), requestId);
}

function redactedProvider(input: ProviderInput) {
  return {
    key: input.key,
    name: input.name,
    adapter: input.adapter,
    enabled: input.enabled,
    allowedDomains: input.allowedDomains,
    priority: input.priority,
    timeoutMs: input.timeoutMs,
    enabledRegions: input.enabledRegions,
    consentRequired: input.consentRequired,
    configKeys: Object.keys(input.config).sort(),
  };
}

function redactVast(value: Record<string, unknown>) {
  let tagOrigin: string | null = null;
  if (typeof value.tagUrl === "string") {
    try {
      tagOrigin = new URL(value.tagUrl).origin;
    } catch {
      tagOrigin = null;
    }
  }
  return {
    enabled: value.enabled === true,
    tagOrigin,
    allowedHosts: Array.isArray(value.allowedHosts) ? value.allowedHosts : [],
    firstBreakSeconds: value.firstBreakSeconds,
    intervalSeconds: value.intervalSeconds,
    maxBreaks: value.maxBreaks,
    allowSkip: value.allowSkip,
    skipAfterSeconds: value.skipAfterSeconds,
  };
}
