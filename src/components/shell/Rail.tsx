'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { Logo } from '@/components/ui/Logo';
import { ACCOUNT_NAV, PRIMARY_NAV, type NavItem } from './nav-items';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group flex h-12 items-center gap-3 rounded-md px-3 transition-colors',
        'text-content-muted hover:bg-surface-raised hover:text-content',
        active && 'bg-surface-raised text-content',
      )}
    >
      <span aria-hidden="true" className="grid w-6 shrink-0 place-items-center text-lg">
        {item.icon}
      </span>
      <span className="truncate text-sm font-medium opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100">
        {item.label}
      </span>
    </Link>
  );
}

/**
 * Compact expandable desktop rail (Section 3). Collapsed by default; expands
 * on hover/focus-within to reveal labels. Hidden on small screens where the
 * bottom nav takes over.
 */
export function Rail() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'group/rail fixed inset-y-0 left-0 z-40 hidden flex-col justify-between border-r border-border',
        'bg-surface/80 px-2 py-4 backdrop-blur-md transition-[width] duration-200 ease-deliberate',
        'w-16 hover:w-56 focus-within:w-56 md:flex',
      )}
    >
      <div className="flex flex-col gap-1">
        <Link href="/" className="mb-4 flex h-12 items-center gap-3 px-3" aria-label="Lumora home">
          <Logo size={26} className="w-6 shrink-0" priority />
          <span className="font-display text-lg font-bold opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100">
            Lumora
          </span>
        </Link>
        {PRIMARY_NAV.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {ACCOUNT_NAV.map((item) => (
          <RailLink key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </div>
    </nav>
  );
}
