CREATE TABLE auth_email_retries (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verification', 'password_reset')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_error_code TEXT NOT NULL CHECK (length(last_error_code) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (account_id, kind)
);
CREATE INDEX auth_email_retries_pending_idx
  ON auth_email_retries(status, available_at, updated_at)
  WHERE status = 'pending';
