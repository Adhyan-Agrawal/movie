import { cn } from '@/lib/cn';
import type { HealthService, HealthStatus } from './mock';

/**
 * Health status grid (Section 15 — db, auth, storage, TMDB, email, ads,
 * playback). Status is conveyed by an icon glyph + a written word in addition
 * to color, so it never relies on color alone (WCAG 1.4.1).
 */

const statusMeta: Record<HealthStatus, { label: string; icon: string; dot: string; badge: string }> = {
  ok: { label: 'Operational', icon: '✓', dot: 'bg-success', badge: 'border-success/40 bg-success/10 text-success' },
  degraded: { label: 'Degraded', icon: '!', dot: 'bg-warning', badge: 'border-warning/40 bg-warning/10 text-warning' },
  down: { label: 'Down', icon: '✕', dot: 'bg-danger', badge: 'border-danger/40 bg-danger/10 text-danger' },
};

function formatChecked(iso: string): string {
  const date = new Date(iso);
  return `${date.toISOString().slice(11, 16)} UTC`;
}

export function HealthGrid({ services, className }: { services: HealthService[]; className?: string }) {
  return (
    <ul className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {services.map((service) => {
        const meta = statusMeta[service.status];
        return (
          <li
            key={service.id}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-soft"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className={cn('h-2 w-2 rounded-full', meta.dot)} />
                <h3 className="text-sm font-semibold text-content">{service.label}</h3>
              </div>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium',
                  meta.badge,
                )}
              >
                <span aria-hidden="true">{meta.icon}</span>
                {meta.label}
              </span>
            </div>
            <p className="text-xs text-content-muted">{service.detail}</p>
            <p className="text-[11px] text-content-subtle">Last checked {formatChecked(service.lastChecked)}</p>
          </li>
        );
      })}
    </ul>
  );
}
