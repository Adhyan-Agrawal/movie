'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

interface AccountSection {
  href: string;
  label: string;
}

const ACCOUNT_SECTIONS: AccountSection[] = [
  { href: '/account', label: 'Overview' },
  { href: '/account/profiles', label: 'Profiles' },
  { href: '/account/watchlist', label: 'Watchlist' },
  { href: '/account/history', label: 'History' },
  { href: '/account/settings', label: 'Settings' },
  { href: '/account/devices', label: 'Devices' },
  { href: '/account/notifications', label: 'Notifications' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/account') return pathname === '/account';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Sub-navigation for the account area (Section 3). Horizontal underlined tabs
 * on desktop; horizontally scrollable on mobile. These are route links, so we
 * use a nav landmark with aria-current rather than ARIA tab semantics.
 */
export function AccountNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Account sections" className="border-b border-border">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {ACCOUNT_SECTIONS.map((item) => {
          const active = isActive(pathname, item.href);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex h-11 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-primary text-content'
                    : 'border-transparent text-content-muted hover:text-content',
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
