CREATE TABLE api_idempotency (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 100),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  status INTEGER NOT NULL CHECK (status BETWEEN 200 AND 299),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (account_id, scope, key)
);
CREATE INDEX api_idempotency_expiry_idx ON api_idempotency(expires_at);

CREATE TABLE transcode_jobs (
  id TEXT PRIMARY KEY CHECK (length(id) = 36),
  input_key TEXT NOT NULL CHECK (length(input_key) BETWEEN 1 AND 1024 AND input_key NOT LIKE '%..%'),
  output_prefix TEXT NOT NULL CHECK (length(output_prefix) BETWEEN 1 AND 1024 AND output_prefix NOT LIKE '%..%'),
  preset TEXT NOT NULL CHECK (preset IN ('hls-1080p', 'hls-adaptive')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_by TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX transcode_jobs_status_idx ON transcode_jobs(status, created_at, id);
