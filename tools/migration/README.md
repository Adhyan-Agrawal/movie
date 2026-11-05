# Lumora migration tools

These tools are offline-first and never infer or scan environment secrets.

1. `npm run export -- --output <dir>` prints an export plan and reads no secret.
2. Add `--execute --allow-network-source --database-url-env <EXPLICIT_NAME>` only during an approved export window. The value is passed to `psql` through `PGDATABASE`, never a command argument or log.
3. `npm run transform -- --input <export-dir> --output <empty-dir>` verifies source checksums, UUIDs, duplicate keys, and cross-table foreign keys before producing D1-normalized NDJSON.
4. `npm run import -- --input <transform-dir>` is a dry-run. Add `--write-sql --output <empty-dir>` to generate deterministic SQL without applying it.
5. `--apply-local --database <local-name> --confirm-empty-target` is restricted to database names containing `local`, `dev`, or `test` and always invokes Wrangler with `--local`. Remote apply is intentionally unsupported.
6. `npm run snapshot:local -- --database lumora-api-local --output <empty-dir>` is a no-access dry-run. Add `--execute-local` to create the offline target snapshot using Wrangler's `--local` flag only.
7. `npm run reconcile -- --source <transform-dir> --target <offline-target-snapshot>` compares counts, canonical row checksums, and primary keys without printing row data.

The public-table pipeline does not contain Supabase `auth.users` credentials. Better Auth credential/session cutover requires a separately approved account-claim or password-reset plan.
