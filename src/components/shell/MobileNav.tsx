'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';

const items: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Home', icon: 'home' }, { href: '/browse', label: 'Discover', icon: 'discover' },
  { href: '/search', label: 'Search', icon: 'search' }, { href: '/account/watchlist', label: 'My list', icon: 'bookmark' },
  { href: '/account', label: 'Account', icon: 'user' },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mobile bottom navigation (Section 3). Hidden on md+ where the rail shows. */
export function MobileNav({ accountsAvailable = true }: { accountsAvailable?: boolean }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'site-mobile-nav fixed inset-x-0 bottom-0 z-40 flex md:hidden',
        // Lift the bar above the iOS home indicator. The links keep their own
        // py-2; this inset is added below it, not swapped in for it.
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      {items.map((item) => {
         if (!accountsAvailable && item.href.startsWith('/account')) return <button key={item.href} type="button" disabled
           className="site-mobile-nav-link opacity-50" aria-label={`${item.label} unavailable`} title={ACCOUNT_SERVICES_UNAVAILABLE}>
           <Icon name={item.icon} width="21" height="21" /><span>{item.label} offline</span>
         </button>;
         const active = isActive(pathname, item.href) && !items.some((other) => other.href.length > item.href.length && other.href.startsWith(`${item.href}/`) && isActive(pathname, other.href));
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'site-mobile-nav-link', active && 'is-active',
            )}
          >
            <Icon name={item.icon} width="21" height="21" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
