'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Desktop navigation stays explicit rather than expanding over the artwork. */
export function Rail() {
  const pathname = usePathname();
  const items = [{ href: '/', label: 'Home' }, { href: '/browse', label: 'Discover' }, { href: '/movies', label: 'Movies' }, { href: '/tv', label: 'Series' }];
  return (
    <nav aria-label="Primary" className="site-primary-nav">
      {items.map((item) => <Link key={item.href} href={item.href} prefetch={false} aria-current={isActive(pathname, item.href) ? 'page' : undefined} className={cn('site-nav-link', isActive(pathname, item.href) && 'is-active')}>{item.label}</Link>)}
    </nav>
  );
}
