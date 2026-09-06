'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { ADMIN_NAV, type AdminNavItem } from './nav';

/**
 * Admin console sidebar (Section 3 — admin navigation is separate from the
 * public app). Rendered inside the public AppShell's main region, so it is the
 * primary navigation for the console. Collapses to a horizontal scroller on
 * small screens.
 */

function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SidebarLink({ item, active }: { item: AdminNavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={item.hint}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        'min-h-11 shrink-0 md:min-h-0', // 44px targets on touch
        active
          ? 'bg-surface-raised font-medium text-content'
          : 'text-content-muted hover:bg-surface-raised/60 hover:text-content',
      )}
    >
      <span aria-hidden="true" className="grid w-5 shrink-0 place-items-center text-base">
        {item.icon}
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Admin"
      className={cn(
        'shrink-0 border-border md:w-56 md:border-r md:pr-3',
        'md:sticky md:top-16 md:h-[calc(100dvh-4rem)] md:overflow-y-auto',
      )}
    >
      <div className="hidden px-3 py-4 md:block">
        <p className="font-display text-sm font-bold text-content">Lumora Admin</p>
        <p className="text-xs text-content-subtle">Content operations</p>
      </div>
      <ul className="flex gap-1 overflow-x-auto py-2 md:flex-col md:overflow-visible md:py-0">
        {ADMIN_NAV.map((item) => (
          <li key={item.href} className="shrink-0">
            <SidebarLink item={item} active={isActive(pathname, item.href)} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
