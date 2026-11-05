-- Stable UUIDs make role/permission reconciliation deterministic across D1,
-- exported Supabase rows, fixtures, and local development.
INSERT INTO roles(id, key, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'owner', 'Owner'),
  ('00000000-0000-4000-8000-000000000002', 'admin', 'Administrator'),
  ('00000000-0000-4000-8000-000000000003', 'editor', 'Content editor'),
  ('00000000-0000-4000-8000-000000000004', 'viewer', 'Viewer');

INSERT INTO permissions(id, key, description) VALUES
  ('00000000-0000-4000-8000-000000000101', 'catalog.read', 'Read draft/private catalog'),
  ('00000000-0000-4000-8000-000000000102', 'catalog.create', 'Create and edit catalog entries'),
  ('00000000-0000-4000-8000-000000000103', 'catalog.publish', 'Publish or unpublish titles'),
  ('00000000-0000-4000-8000-000000000104', 'catalog.delete', 'Delete catalog entries'),
  ('00000000-0000-4000-8000-000000000105', 'provider.manage', 'Manage playback providers and sources'),
  ('00000000-0000-4000-8000-000000000106', 'ads.manage', 'Manage advertising'),
  ('00000000-0000-4000-8000-000000000107', 'email.manage', 'Manage email settings and templates'),
  ('00000000-0000-4000-8000-000000000108', 'users.read', 'Read user accounts'),
  ('00000000-0000-4000-8000-000000000109', 'users.suspend', 'Suspend user accounts'),
  ('00000000-0000-4000-8000-000000000110', 'roles.manage', 'Manage roles and permissions'),
  ('00000000-0000-4000-8000-000000000111', 'analytics.read', 'Read analytics'),
  ('00000000-0000-4000-8000-000000000112', 'settings.manage', 'Manage site settings'),
  ('00000000-0000-4000-8000-000000000113', 'audit.read', 'Read audit logs'),
  ('00000000-0000-4000-8000-000000000114', 'health.read', 'Read system health'),
  ('00000000-0000-4000-8000-000000000115', 'plans.manage', 'Manage plan versions and audited manual access grants'),
  ('00000000-0000-4000-8000-000000000116', 'billing.read', 'Read subscription and manual access records');

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.key IN ('owner', 'admin');

INSERT INTO role_permissions(role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
  ON p.key IN ('catalog.read', 'catalog.create', 'catalog.publish')
WHERE r.key = 'editor';
