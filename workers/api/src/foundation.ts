export async function ensureAccountFoundation(db: D1Database, accountId: string, displayName: string): Promise<void> {
  const currentProfile = await db.prepare(
    "SELECT id FROM profiles WHERE account_id = ? ORDER BY created_at, id LIMIT 1",
  ).bind(accountId).first<{ id: string }>();

  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT OR IGNORE INTO account_members(account_id, role_id)
       SELECT ?, id FROM roles WHERE key = 'viewer'`,
    ).bind(accountId),
  ];

  let profileId = currentProfile?.id;
  if (!profileId) {
    profileId = crypto.randomUUID();
    const profileName = displayName.trim().slice(0, 80) || "Viewer";
    statements.push(
      db.prepare(
        "INSERT OR IGNORE INTO profiles(id, account_id, name) VALUES (?, ?, ?)",
      ).bind(profileId, accountId, profileName),
    );
  }

  const watchlistId = crypto.randomUUID();
  statements.push(
    db.prepare(
      `INSERT INTO watchlists(id, profile_id, account_id, name, is_default)
       SELECT ?, ?, ?, 'My list', 1
       WHERE EXISTS (SELECT 1 FROM profiles WHERE id = ? AND account_id = ?)
         AND NOT EXISTS (SELECT 1 FROM watchlists WHERE profile_id = ? AND is_default = 1)`,
    ).bind(watchlistId, profileId, accountId, profileId, accountId, profileId),
  );
  await db.batch(statements);
}
