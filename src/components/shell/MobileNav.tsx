'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { PRIMARY_NAV } from './nav-items';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mobile bottom navigation (Section 3). Hidden on md+ where the rail shows. */
export function MobileNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/90 backdrop-blur-md md:hidden',
        'pb-[env(safe-area-inset-bottom)]',
      )}
    >
      {PRIMARY_NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]',
              'min-h-[56px] transition-colors',
              active ? 'text-primary' : 'text-content-muted',
            )}
          >
            <span aria-hidden="true" className="text-lg leading-none">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
