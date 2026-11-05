-- Forward-only D1 translation of the 45-table Supabase public schema.
-- `accounts` is migration 0000's Better Auth user table. This migration adds
-- the remaining 44 domain tables. It deliberately never drops/recreates the
-- watchlist tables from the destructive Supabase 0005 migration.
PRAGMA foreign_keys = ON;

CREATE TABLE roles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500)
);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX role_permissions_permission_idx ON role_permissions(permission_id);

CREATE TABLE account_members (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, role_id)
);
CREATE INDEX account_members_role_idx ON account_members(role_id);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  avatar TEXT CHECK (avatar IS NULL OR length(avatar) <= 2048),
  maturity_ceiling TEXT NOT NULL DEFAULT 'TV-MA' CHECK (length(maturity_ceiling) BETWEEN 1 AND 20),
  is_kids INTEGER NOT NULL DEFAULT 0 CHECK (is_kids IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, name)
);
CREATE INDEX profiles_account_idx ON profiles(account_id);

CREATE TABLE genres (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100)
);

CREATE TABLE titles (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  type TEXT NOT NULL CHECK (type IN ('movie', 'tv')),
  tmdb_id INTEGER,
  imdb_id TEXT CHECK (imdb_id IS NULL OR length(imdb_id) <= 32),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  original_name TEXT CHECK (original_name IS NULL OR length(original_name) <= 300),
  synopsis TEXT NOT NULL DEFAULT '' CHECK (length(synopsis) <= 20000),
  release_year INTEGER CHECK (release_year BETWEEN 1878 AND 2100),
  runtime_minutes INTEGER CHECK (runtime_minutes >= 0 AND runtime_minutes <= 10000),
  maturity TEXT NOT NULL DEFAULT 'NR' CHECK (length(maturity) <= 20),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'published', 'archived')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  original_language TEXT NOT NULL DEFAULT 'en' CHECK (length(original_language) BETWEEN 2 AND 16),
  poster_url TEXT CHECK (poster_url IS NULL OR length(poster_url) <= 2048),
  backdrop_url TEXT CHECK (backdrop_url IS NULL OR length(backdrop_url) <= 2048),
  trailer_url TEXT CHECK (trailer_url IS NULL OR length(trailer_url) <= 2048),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  editorial_score INTEGER CHECK (editorial_score BETWEEN 0 AND 100),
  popularity REAL,
  published_at TEXT,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX titles_tmdb_type_idx ON titles(type, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX titles_status_visibility_idx ON titles(status, visibility, published_at);
CREATE INDEX titles_featured_idx ON titles(featured) WHERE featured = 1;
CREATE INDEX titles_popularity_idx ON titles(popularity DESC, editorial_score DESC, id);

CREATE TABLE title_genres (
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  genre_id TEXT NOT NULL REFERENCES genres(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, genre_id)
);
CREATE INDEX title_genres_genre_idx ON title_genres(genre_id, title_id);

CREATE TABLE seasons (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_number INTEGER NOT NULL CHECK (season_number >= 0),
  name TEXT CHECK (name IS NULL OR length(name) <= 300),
  overview TEXT NOT NULL DEFAULT '' CHECK (length(overview) <= 20000),
  air_date TEXT CHECK (air_date IS NULL OR length(air_date) = 10),
  poster_url TEXT CHECK (poster_url IS NULL OR length(poster_url) <= 2048),
  episode_count INTEGER CHECK (episode_count >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (title_id, season_number)
);
CREATE INDEX seasons_title_idx ON seasons(title_id, season_number);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_id TEXT REFERENCES seasons(id) ON DELETE CASCADE,
  season_number INTEGER CHECK (season_number >= 0),
  episode_number INTEGER NOT NULL CHECK (episode_number >= 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  overview TEXT NOT NULL DEFAULT '' CHECK (length(overview) <= 20000),
  air_date TEXT CHECK (air_date IS NULL OR length(air_date) = 10),
  runtime_minutes INTEGER CHECK (runtime_minutes >= 0 AND runtime_minutes <= 10000),
  still_url TEXT CHECK (still_url IS NULL OR length(still_url) <= 2048),
  tmdb_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (season_id, episode_number)
);
CREATE INDEX episodes_title_idx ON episodes(title_id, season_number, episode_number);
CREATE INDEX episodes_season_idx ON episodes(season_id, episode_number);

CREATE TABLE people (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  tmdb_id INTEGER,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  known_for TEXT CHECK (known_for IS NULL OR length(known_for) <= 300),
  biography TEXT NOT NULL DEFAULT '' CHECK (length(biography) <= 50000),
  birthday TEXT CHECK (birthday IS NULL OR length(birthday) = 10),
  profile_url TEXT CHECK (profile_url IS NULL OR length(profile_url) <= 2048),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX people_tmdb_idx ON people(tmdb_id) WHERE tmdb_id IS NOT NULL;

CREATE TABLE title_people (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  credit_type TEXT NOT NULL CHECK (credit_type IN ('cast', 'crew')),
  character TEXT,
  job TEXT,
  department TEXT,
  credit_order INTEGER NOT NULL DEFAULT 0 CHECK (credit_order >= 0)
);
CREATE UNIQUE INDEX title_people_unique_credit_idx
  ON title_people(title_id, person_id, credit_type, coalesce(job, ''), coalesce(character, ''));
CREATE INDEX title_people_title_idx ON title_people(title_id, credit_type, credit_order);
CREATE INDEX title_people_person_idx ON title_people(person_id, credit_order);

CREATE TABLE collections (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 200),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 10000),
  kind TEXT NOT NULL DEFAULT 'editorial' CHECK (kind IN ('editorial', 'franchise', 'auto')),
  is_public INTEGER NOT NULL DEFAULT 1 CHECK (is_public IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  published_at TEXT,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX collections_visibility_idx ON collections(is_public, published_at, sort_order);

CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (collection_id, title_id)
);
CREATE INDEX collection_items_title_idx ON collection_items(title_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE title_tags (
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, tag_id)
);
CREATE INDEX title_tags_tag_idx ON title_tags(tag_id, title_id);

CREATE TABLE providers (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  adapter TEXT NOT NULL DEFAULT 'generic' CHECK (length(adapter) <= 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  base_url TEXT CHECK (base_url IS NULL OR length(base_url) <= 2048),
  allowed_domains TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_domains) AND json_type(allowed_domains) = 'array'),
  movie_path_template TEXT CHECK (movie_path_template IS NULL OR length(movie_path_template) <= 2048),
  series_path_template TEXT CHECK (series_path_template IS NULL OR length(series_path_template) <= 2048),
  episode_path_template TEXT CHECK (episode_path_template IS NULL OR length(episode_path_template) <= 2048),
  shorthand_episode_template TEXT CHECK (shorthand_episode_template IS NULL OR length(shorthand_episode_template) <= 2048),
  priority INTEGER NOT NULL DEFAULT 100,
  timeout_ms INTEGER NOT NULL DEFAULT 8000 CHECK (timeout_ms BETWEEN 100 AND 30000),
  enabled_regions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(enabled_regions) AND json_type(enabled_regions) = 'array'),
  consent_required INTEGER NOT NULL DEFAULT 0 CHECK (consent_required IN (0, 1)),
  test_title_id TEXT CHECK (test_title_id IS NULL OR length(test_title_id) <= 100),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config) AND json_type(config) = 'object'),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'degraded', 'down')),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX providers_enabled_idx ON providers(enabled, priority, key);

CREATE TABLE media_sources (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mp4', 'hls', 'dash', 'youtube', 'vimeo', 'dailymotion', 'vsembed', 'iframe', 'embed', 'custom')),
  url TEXT CHECK (url IS NULL OR length(url) <= 4096),
  reference TEXT CHECK (reference IS NULL OR length(reference) <= 2048),
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 200),
  language TEXT NOT NULL DEFAULT 'en' CHECK (length(language) <= 16),
  quality TEXT NOT NULL DEFAULT 'auto' CHECK (length(quality) <= 32),
  priority INTEGER NOT NULL DEFAULT 100,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  consent_required INTEGER NOT NULL DEFAULT 0 CHECK (consent_required IN (0, 1)),
  geo_policy TEXT NOT NULL DEFAULT '{"mode":"allow","regions":[]}' CHECK (json_valid(geo_policy) AND json_type(geo_policy) = 'object'),
  safe_headers TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(safe_headers) AND json_type(safe_headers) = 'object'),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'degraded', 'down')),
  last_checked_at TEXT,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (url IS NOT NULL OR reference IS NOT NULL)
);
CREATE INDEX media_sources_title_idx ON media_sources(title_id, enabled, priority);
CREATE INDEX media_sources_episode_idx ON media_sources(episode_id, enabled, priority);
CREATE INDEX media_sources_provider_idx ON media_sources(provider_id);
CREATE UNIQUE INDEX media_sources_one_default_idx
  ON media_sources(title_id, coalesce(episode_id, '00000000-0000-0000-0000-000000000000'))
  WHERE is_default = 1;

CREATE TABLE subtitle_tracks (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  source_id TEXT REFERENCES media_sources(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 1 AND 16),
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  kind TEXT NOT NULL DEFAULT 'subtitles' CHECK (kind IN ('subtitles', 'captions', 'sdh', 'forced')),
  url TEXT CHECK (url IS NULL OR length(url) <= 4096),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX subtitle_tracks_source_idx ON subtitle_tracks(source_id);
CREATE INDEX subtitle_tracks_title_idx ON subtitle_tracks(title_id);

CREATE TABLE audio_tracks (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  source_id TEXT REFERENCES media_sources(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 1 AND 16),
  label TEXT CHECK (label IS NULL OR length(label) <= 200),
  channels TEXT CHECK (channels IS NULL OR length(channels) <= 100),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audio_tracks_source_idx ON audio_tracks(source_id);
CREATE INDEX audio_tracks_title_idx ON audio_tracks(title_id);

CREATE TABLE playback_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES media_sources(id) ON DELETE SET NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
  device TEXT CHECK (device IS NULL OR length(device) <= 200),
  state TEXT NOT NULL DEFAULT 'idle' CHECK (length(state) <= 32),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX playback_sessions_account_idx ON playback_sessions(account_id, created_at DESC);
CREATE INDEX playback_sessions_profile_idx ON playback_sessions(profile_id, created_at DESC);
CREATE INDEX playback_sessions_title_idx ON playback_sessions(title_id, created_at DESC);

CREATE TABLE watch_progress (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0 CHECK (position_seconds >= 0),
  duration_seconds INTEGER CHECK (duration_seconds >= 0),
  progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX watch_progress_unique_idx
  ON watch_progress(profile_id, title_id, coalesce(episode_id, '00000000-0000-0000-0000-000000000000'));
CREATE INDEX watch_progress_recent_idx ON watch_progress(profile_id, updated_at DESC, id);
CREATE INDEX watch_progress_account_idx ON watch_progress(account_id, updated_at DESC);

CREATE TABLE watchlists (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My list' CHECK (length(trim(name)) BETWEEN 1 AND 100),
  is_default INTEGER NOT NULL DEFAULT 1 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (profile_id, name)
);
CREATE INDEX watchlists_profile_idx ON watchlists(profile_id);
CREATE INDEX watchlists_account_idx ON watchlists(account_id);
CREATE UNIQUE INDEX watchlists_one_default_idx ON watchlists(profile_id) WHERE is_default = 1;

CREATE TABLE watchlist_items (
  watchlist_id TEXT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (watchlist_id, title_id)
);
CREATE INDEX watchlist_items_watchlist_idx ON watchlist_items(watchlist_id, sort_order, added_at DESC);
CREATE INDEX watchlist_items_title_idx ON watchlist_items(title_id);

CREATE TABLE ratings (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 10),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (profile_id, title_id)
);
CREATE INDEX ratings_title_idx ON ratings(title_id);
CREATE INDEX ratings_account_idx ON ratings(account_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 10000),
  rating INTEGER CHECK (rating BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (profile_id, title_id)
);
CREATE INDEX reviews_title_idx ON reviews(title_id, status, created_at DESC);
CREATE INDEX reviews_account_idx ON reviews(account_id);

CREATE TABLE comments (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  status TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX comments_title_idx ON comments(title_id, status, created_at DESC);
CREATE INDEX comments_parent_idx ON comments(parent_id, created_at);
CREATE INDEX comments_account_idx ON comments(account_id);

CREATE TABLE recent_searches (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  query TEXT NOT NULL CHECK (length(trim(query)) BETWEEN 1 AND 300),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX recent_searches_recent_idx ON recent_searches(profile_id, created_at DESC);
CREATE INDEX recent_searches_account_idx ON recent_searches(account_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'system' CHECK (kind IN ('system', 'availability', 'episode', 'moderation', 'security', 'import')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  body TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 10000),
  data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data) AND json_type(data) = 'object'),
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX notifications_recent_idx ON notifications(account_id, created_at DESC, id);
CREATE INDEX notifications_unread_idx ON notifications(account_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE site_settings (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(value)),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (key <> 'playback_vast' OR is_public = 0)
);
CREATE INDEX site_settings_public_idx ON site_settings(is_public, key);

CREATE TABLE feature_flags (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)),
  rollout TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rollout) AND json_type(rollout) = 'object'),
  updated_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX feature_flags_public_idx ON feature_flags(is_public, key);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 200),
  entity_type TEXT CHECK (entity_type IS NULL OR length(entity_type) <= 100),
  entity_id TEXT CHECK (entity_id IS NULL OR length(entity_id) <= 200),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure')),
  "before" TEXT CHECK ("before" IS NULL OR json_valid("before")),
  "after" TEXT CHECK ("after" IS NULL OR json_valid("after")),
  ip TEXT CHECK (ip IS NULL OR length(ip) <= 64),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  request_id TEXT CHECK (request_id IS NULL OR length(request_id) <= 100),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC, id);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_account_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id, created_at DESC);

CREATE TABLE imports (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  kind TEXT NOT NULL CHECK (kind IN ('csv', 'json', 'tmdb')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'partial')),
  source TEXT CHECK (source IS NULL OR length(source) <= 2048),
  mapping TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mapping) AND json_type(mapping) = 'object'),
  dry_run INTEGER NOT NULL DEFAULT 1 CHECK (dry_run IN (0, 1)),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0),
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed >= 0),
  succeeded INTEGER NOT NULL DEFAULT 0 CHECK (succeeded >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  error_report TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(error_report) AND json_type(error_report) = 'array'),
  idempotency_key TEXT,
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX imports_idempotency_idx ON imports(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX imports_status_idx ON imports(status, created_at);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 100),
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 500),
  event_type TEXT CHECK (event_type IS NULL OR length(event_type) <= 200),
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  signature TEXT CHECK (signature IS NULL OR length(signature) <= 2048),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed', 'skipped')),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_status_idx ON webhook_events(status, created_at);

CREATE TABLE health_checks (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  component TEXT NOT NULL CHECK (length(component) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'degraded', 'down')),
  latency_ms INTEGER CHECK (latency_ms >= 0),
  detail TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail) AND json_type(detail) = 'object'),
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX health_checks_component_idx ON health_checks(component, checked_at DESC);

CREATE TABLE ad_providers (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config) AND json_type(config) = 'object'),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE ad_placements (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  key TEXT NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  format TEXT NOT NULL CHECK (format IN ('preroll', 'midroll', 'postroll', 'display', 'native', 'banner', 'house')),
  position TEXT CHECK (position IS NULL OR length(position) <= 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  device_targeting TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(device_targeting) AND json_type(device_targeting) = 'object'),
  frequency_cap INTEGER CHECK (frequency_cap >= 0),
  cooldown_seconds INTEGER CHECK (cooldown_seconds >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ad_placements_enabled_idx ON ad_placements(enabled, key);

CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  provider_id TEXT REFERENCES ad_providers(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  consent_required INTEGER NOT NULL DEFAULT 1 CHECK (consent_required IN (0, 1)),
  starts_at TEXT,
  ends_at TEXT,
  kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  revenue_meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(revenue_meta) AND json_type(revenue_meta) = 'object'),
  created_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX ad_campaigns_provider_idx ON ad_campaigns(provider_id);
CREATE INDEX ad_campaigns_active_idx ON ad_campaigns(enabled, kill_switch, starts_at, ends_at);

CREATE TABLE ad_creatives (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  placement_id TEXT REFERENCES ad_placements(id) ON DELETE SET NULL,
  format TEXT NOT NULL CHECK (format IN ('preroll', 'midroll', 'postroll', 'display', 'native', 'banner', 'house')),
  asset_url TEXT CHECK (asset_url IS NULL OR length(asset_url) <= 4096),
  click_url TEXT CHECK (click_url IS NULL OR length(click_url) <= 4096),
  html TEXT CHECK (html IS NULL OR length(html) <= 100000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ad_creatives_campaign_idx ON ad_creatives(campaign_id, enabled, weight);
CREATE INDEX ad_creatives_placement_idx ON ad_creatives(placement_id, enabled);

CREATE TABLE ad_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  creative_id TEXT REFERENCES ad_creatives(id) ON DELETE SET NULL,
  placement_id TEXT REFERENCES ad_placements(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES ad_campaigns(id) ON DELETE SET NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('impression', 'click', 'complete', 'skip', 'error')),
  meta TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta) AND json_type(meta) = 'object'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ad_events_campaign_idx ON ad_events(campaign_id, created_at DESC);
CREATE INDEX ad_events_type_idx ON ad_events(type, created_at DESC);
CREATE INDEX ad_events_creative_idx ON ad_events(creative_id, created_at DESC);

CREATE TABLE title_requests (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title_name TEXT NOT NULL CHECK (length(trim(title_name)) BETWEEN 1 AND 300),
  media_type TEXT NOT NULL DEFAULT 'movie' CHECK (media_type IN ('movie', 'tv')),
  year INTEGER CHECK (year BETWEEN 1878 AND 2100),
  note TEXT CHECK (note IS NULL OR length(note) <= 2000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX title_requests_status_idx ON title_requests(status, created_at);
CREATE INDEX title_requests_account_idx ON title_requests(account_id, created_at DESC);

CREATE TABLE playback_reports (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  title_id TEXT REFERENCES titles(id) ON DELETE SET NULL,
  episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  server_label TEXT CHECK (server_label IS NULL OR length(server_label) <= 100),
  player_state TEXT CHECK (player_state IS NULL OR length(player_state) <= 100),
  message TEXT CHECK (message IS NULL OR length(message) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX playback_reports_created_idx ON playback_reports(created_at DESC, id);
CREATE INDEX playback_reports_title_idx ON playback_reports(title_id, created_at DESC);

CREATE TABLE commerce_plans (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 2 AND 64 AND slug NOT GLOB '*[^a-z0-9-]*'),
  version INTEGER NOT NULL CHECK (version > 0),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  price_minor INTEGER NOT NULL CHECK (price_minor BETWEEN 0 AND 100000000),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year', 'one_time')),
  ad_free INTEGER NOT NULL DEFAULT 0 CHECK (ad_free IN (0, 1)),
  max_profiles INTEGER NOT NULL DEFAULT 1 CHECK (max_profiles BETWEEN 1 AND 20),
  features TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(features) AND json_type(features) = 'array'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (slug, version),
  CHECK ((status = 'draft' AND published_at IS NULL) OR status <> 'draft')
);
CREATE UNIQUE INDEX commerce_plans_live_slug ON commerce_plans(slug) WHERE status = 'published';
CREATE INDEX commerce_plans_public_idx ON commerce_plans(status, slug, version DESC);

CREATE TABLE commerce_subscriptions (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES commerce_plans(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'admin_grant' CHECK (source = 'admin_grant'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  starts_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  access_until TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 5 AND 1000),
  granted_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (access_until > starts_at),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX commerce_subscriptions_account_idx ON commerce_subscriptions(account_id, access_until DESC, id);
CREATE INDEX commerce_subscriptions_plan_idx ON commerce_subscriptions(plan_id, status);

-- Transactional outbox and consumer ledger. D1 is canonical; Queue delivery is
-- at-least-once and consumers deduplicate by the stable event UUID.
CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 100),
  aggregate_type TEXT NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 100),
  aggregate_id TEXT NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 2000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(published_at, available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE processed_events (
  consumer TEXT NOT NULL CHECK (length(consumer) BETWEEN 1 AND 100),
  event_id TEXT NOT NULL CHECK (length(event_id) = 36),
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE api_rate_limits (
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 200),
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX api_rate_limits_expiry_idx ON api_rate_limits(expires_at);

CREATE TABLE media_capabilities (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  object_prefix TEXT NOT NULL CHECK (length(object_prefix) BETWEEN 1 AND 1024 AND object_prefix NOT LIKE '%..%'),
  expires_at INTEGER NOT NULL,
  nonce_hash TEXT NOT NULL CHECK (length(nonce_hash) = 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (expires_at > created_at)
);
CREATE INDEX media_capabilities_expiry_idx ON media_capabilities(expires_at);

-- FTS5 replaces PostgreSQL trigram indexes. Triggers keep the search indexes
-- synchronized deterministically with the canonical relational rows.
CREATE VIRTUAL TABLE titles_fts USING fts5(
  title_id UNINDEXED,
  name,
  original_name,
  synopsis,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER titles_fts_insert AFTER INSERT ON titles BEGIN
  INSERT INTO titles_fts(title_id, name, original_name, synopsis)
  VALUES (new.id, new.name, coalesce(new.original_name, ''), new.synopsis);
END;
CREATE TRIGGER titles_fts_update AFTER UPDATE OF name, original_name, synopsis ON titles BEGIN
  DELETE FROM titles_fts WHERE title_id = old.id;
  INSERT INTO titles_fts(title_id, name, original_name, synopsis)
  VALUES (new.id, new.name, coalesce(new.original_name, ''), new.synopsis);
END;
CREATE TRIGGER titles_fts_delete AFTER DELETE ON titles BEGIN
  DELETE FROM titles_fts WHERE title_id = old.id;
END;

CREATE VIRTUAL TABLE people_fts USING fts5(
  person_id UNINDEXED,
  name,
  known_for,
  biography,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER people_fts_insert AFTER INSERT ON people BEGIN
  INSERT INTO people_fts(person_id, name, known_for, biography)
  VALUES (new.id, new.name, coalesce(new.known_for, ''), new.biography);
END;
CREATE TRIGGER people_fts_update AFTER UPDATE OF name, known_for, biography ON people BEGIN
  DELETE FROM people_fts WHERE person_id = old.id;
  INSERT INTO people_fts(person_id, name, known_for, biography)
  VALUES (new.id, new.name, coalesce(new.known_for, ''), new.biography);
END;
CREATE TRIGGER people_fts_delete AFTER DELETE ON people BEGIN
  DELETE FROM people_fts WHERE person_id = old.id;
END;

-- Database-level invariants remain in force even if a future route regresses.
CREATE TRIGGER profiles_owner_immutable
BEFORE UPDATE OF account_id ON profiles
WHEN new.account_id <> old.account_id
BEGIN
  SELECT RAISE(ABORT, 'profile ownership is immutable');
END;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;

CREATE TRIGGER commerce_plans_published_immutable
BEFORE UPDATE ON commerce_plans
WHEN old.published_at IS NOT NULL AND (
  new.slug <> old.slug OR new.version <> old.version OR new.name <> old.name OR
  new.description <> old.description OR new.currency <> old.currency OR
  new.price_minor <> old.price_minor OR new.billing_interval <> old.billing_interval OR
  new.ad_free <> old.ad_free OR new.max_profiles <> old.max_profiles OR
  new.features <> old.features OR new.status = 'draft'
)
BEGIN
  SELECT RAISE(ABORT, 'published plan versions are immutable');
END;

CREATE TRIGGER reviews_author_status_insert
BEFORE INSERT ON reviews
WHEN new.status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'new reviews must enter moderation');
END;

INSERT INTO site_settings(key, value, is_public, description)
VALUES (
  'playback_vast',
  '{"enabled":false,"tagUrl":"","allowedHosts":[],"firstBreakSeconds":900,"intervalSeconds":900,"maxBreaks":3,"allowSkip":true,"skipAfterSeconds":5}',
  0,
  'Private VAST provider configuration; audited ads.manage writes only'
);
