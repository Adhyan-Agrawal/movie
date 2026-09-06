/** Admin console navigation model (Section 3 — admin navigation is separate). */
export interface AdminNavItem {
  href: string;
  label: string;
  /** Simple glyph; swapped for an icon set later. */
  icon: string;
  /** Short description for the section, used as a tooltip/aria hint. */
  hint: string;
}

export const ADMIN_NAV: AdminNavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: '▦', hint: 'Operations overview and trends' },
  { href: '/admin/catalog/titles', label: 'Catalog', icon: '⛃', hint: 'Titles, episodes, publication' },
  { href: '/admin/sources', label: 'Media', icon: '⇈', hint: 'Uploads, storage, and stream sources' },
  { href: '/admin/sync', label: 'TMDB sync', icon: '⟳', hint: 'One-click import of movies and series from TMDB' },
  { href: '/admin/providers', label: 'Providers', icon: '⧉', hint: 'Playback sources and adapters' },
  { href: '/admin/ads', label: 'Ads', icon: '◫', hint: 'Placements, campaigns, consent' },
  { href: '/admin/users', label: 'Users', icon: '☺', hint: 'Accounts, roles, sessions' },
  { href: '/admin/settings', label: 'Settings', icon: '⚙', hint: 'Brand, playback, privacy, flags' },
  { href: '/admin/audit', label: 'Audit', icon: '☰', hint: 'Immutable change history' },
  { href: '/admin/health', label: 'Health', icon: '✚', hint: 'Service and provider status' },
  { href: '/admin/imports', label: 'Imports', icon: '⇪', hint: 'CSV / JSON ingestion' },
];
