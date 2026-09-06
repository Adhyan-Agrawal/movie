/** Primary navigation model shared by the desktop rail and mobile bottom nav. */
export interface NavItem {
  href: string;
  label: string;
  /** Simple glyph; swapped for an icon set later. */
  icon: string;
}

export const PRIMARY_NAV: NavItem[] = [
  { href: '/', label: 'Home', icon: '⌂' },
  { href: '/browse', label: 'Browse', icon: '▤' },
  { href: '/movies', label: 'Movies', icon: '🎬' },
  { href: '/tv', label: 'TV', icon: '📺' },
  { href: '/search', label: 'Search', icon: '⌕' },
];

export const ACCOUNT_NAV: NavItem[] = [
  { href: '/account/watchlist', label: 'Watchlist', icon: '＋' },
  { href: '/account', label: 'Account', icon: '☺' },
];
