import { cn } from '@/lib/cn';
import { Sparkline } from './Charts';

/**
 * KPI tile (Section 10 dashboard). Restrained, information-dense: a label, a
 * hero value, a signed delta, and an optional sparkline.
 *
 * Accessibility / dataviz: the delta is never color-alone — an arrow glyph and
 * an sr-only phrase ("up 4.1% …") carry the direction, and the sparkline is
 * decorative (aria-hidden) because the delta + value already state the trend.
 */

type DeltaTone = 'success' | 'danger' | 'neutral';

function deltaTone(deltaPct: number, goodDirection: 'up' | 'down'): DeltaTone {
  if (deltaPct === 0) return 'neutral';
  const rising = deltaPct > 0;
  const good = goodDirection === 'up' ? rising : !rising;
  return good ? 'success' : 'danger';
}

const toneText: Record<DeltaTone, string> = {
  success: 'text-success',
  danger: 'text-danger',
  neutral: 'text-content-subtle',
};

const sparkToneFor: Record<DeltaTone, 'primary' | 'success' | 'danger'> = {
  success: 'success',
  danger: 'danger',
  neutral: 'primary',
};

export function StatTile({
  label,
  value,
  deltaPct,
  goodDirection = 'up',
  comparison,
  spark,
  definition,
  className,
}: {
  label: string;
  value: string;
  deltaPct?: number;
  goodDirection?: 'up' | 'down';
  comparison?: string;
  spark?: number[];
  definition?: string;
  className?: string;
}) {
  const hasDelta = typeof deltaPct === 'number';
  const tone = hasDelta ? deltaTone(deltaPct, goodDirection) : 'neutral';
  const arrow = !hasDelta || deltaPct === 0 ? '→' : deltaPct > 0 ? '↑' : '↓';
  const directionWord = !hasDelta || deltaPct === 0 ? 'no change' : deltaPct > 0 ? 'up' : 'down';
  const magnitude = hasDelta ? `${Math.abs(deltaPct).toFixed(1)}%` : '';

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-soft',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-content-muted">{label}</p>
        {definition ? (
          <span
            tabIndex={0}
            role="note"
            aria-label={`Definition: ${definition}`}
            title={definition}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border text-[11px] text-content-subtle"
          >
            <span aria-hidden="true">i</span>
          </span>
        ) : null}
      </div>

      <p className="font-display text-3xl font-bold tracking-tight tabular-nums">{value}</p>

      {hasDelta ? (
        <p className={cn('flex items-center gap-1.5 text-sm', toneText[tone])}>
          <span aria-hidden="true" className="text-base leading-none">
            {arrow}
          </span>
          <span aria-hidden="true">{magnitude}</span>
          {comparison ? (
            <span aria-hidden="true" className="text-content-subtle">
              {comparison}
            </span>
          ) : null}
          <span className="sr-only">{`${directionWord} ${magnitude}${comparison ? ` ${comparison}` : ''}`}</span>
        </p>
      ) : null}

      {spark && spark.length > 1 ? <Sparkline values={spark} tone={sparkToneFor[tone]} /> : null}
    </div>
  );
}
