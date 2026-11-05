export async function seedAccount(
  db: D1Database,
  id: string,
  email: string,
  options: { suspended?: boolean; role?: "owner" | "admin" | "editor" | "viewer" } = {},
): Promise<void> {
  await db.prepare(
    `INSERT INTO accounts(id, display_name, email, email_verified, is_suspended)
     VALUES (?, ?, ?, 1, ?)`,
  ).bind(id, email.split("@", 1)[0] ?? "Viewer", email, options.suspended ? 1 : 0).run();
  const role = options.role ?? "viewer";
  await db.prepare(
    `INSERT INTO account_members(account_id, role_id)
     SELECT ?, id FROM roles WHERE key = ?`,
  ).bind(id, role).run();
}

export async function seedPublishedTitle(db: D1Database, id: string, slug: string): Promise<void> {
  await db.prepare(
    `INSERT INTO titles(id, type, slug, name, status, visibility, published_at)
     VALUES (?, 'movie', ?, ?, 'published', 'public', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
  ).bind(id, slug, slug).run();
}
