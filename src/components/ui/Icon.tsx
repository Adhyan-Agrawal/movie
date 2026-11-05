import type { ReactNode, SVGProps } from 'react';

export type IconName = 'play' | 'search' | 'arrow-right' | 'arrow-left' | 'home' | 'discover' | 'film' | 'tv' | 'bookmark' | 'user' | 'plus' | 'users' | 'close' | 'chevron-down';

const paths: Record<IconName, ReactNode> = {
  play: <path d="m9 5 11 7-11 7V5Z" fill="currentColor" stroke="none" />,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  'arrow-right': <path d="M4 12h16m-6-6 6 6-6 6" />,
  'arrow-left': <path d="M20 12H4m6-6-6 6 6 6" />,
  home: <><path d="m3 10 9-7 9 7v10H3V10Z" /><path d="M9 20v-7h6v7" /></>,
  discover: <><circle cx="12" cy="12" r="9" /><path d="m16 8-2.5 5.5L8 16l2.5-5.5L16 8Z" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16m10-16v16M3 9h4m-4 6h4m10-6h4m-4 6h4" /></>,
  tv: <><rect x="3" y="5" width="18" height="13" rx="2" /><path d="M8 22h8m-4-4v4" /></>,
  bookmark: <path d="M6 3h12v18l-6-4-6 4V3Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  users: <><circle cx="9" cy="8" r="3" /><path d="M2 21v-2a7 7 0 0 1 14 0v2m1-16a3 3 0 0 1 0 6m3 10v-2a6 6 0 0 0-3-5" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
