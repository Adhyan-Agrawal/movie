import { cn } from '@/lib/cn';
import type { TimePoint } from './mock';

/**
 * Inline-SVG dataviz primitives for the admin dashboard.
 *
 * Design follows the dataviz method: thin marks, recessive axes, a single hue
 * for magnitude (no chartjunk, no double-encoding), selective direct labels,
 * and a real accessible alternative for every chart (an sr-only data table or
 * text) so identity/values are never conveyed by color or shape alone.
 * These are pure presentational components (no hooks) — usable in Server or
 * Client Components alike.
 */

type SparkTone = 'primary' | 'success' | 'danger';

const sparkStroke: Record<SparkTone, string> = {
  primary: 'stroke-primary',
  success: 'stroke-success',
  danger: 'stroke-danger',
};

/** Compact trend line for a stat tile. Decorative — callers supply text. */
export function Sparkline({
  values,
  tone = 'primary',
  className,
}: {
  values: number[];
  tone?: SparkTone;
  className?: string;
}) {
  if (values.length < 2) return null;
  const width = 100;
  const height = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const lastValue = values[values.length - 1] ?? min;
  const lastX = width;
  const lastY = height - ((lastValue - min) / range) * height;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('h-8 w-full', className)}
    >
      <polyline
        points={points}
        fill="none"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={sparkStroke[tone]}
      />
      <circle cx={lastX} cy={lastY} r={2.4} vectorEffect="non-scaling-stroke" className={cn('fill-current', sparkStroke[tone])} />
    </svg>
  );
}

/** Build an SVG path for a bar whose top corners are rounded (baseline-anchored). */
function topRoundedBar(x: number, y: number, w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2, h));
  const bottom = y + h;
  return `M${x},${bottom} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${bottom} Z`;
}

/**
 * Vertical bar chart for a single measure over time (magnitude, one hue).
 * Peak bar is direct-labeled; a full sr-only table is the accessible alternative.
 */
export function BarChart({
  data,
  caption,
  unit = '',
  className,
}: {
  data: TimePoint[];
  caption: string;
  unit?: string;
  className?: string;
}) {
  if (data.length === 0) return null;
  const width = 720;
  const height = 180;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  const slot = width / data.length;
  const gap = Math.min(10, slot * 0.28);
  const barW = slot - gap;
  const peak = values.reduce((m, v) => Math.max(m, v), 0);
  const firstLabel = data[0]?.label ?? '';
  const lastLabel = data[data.length - 1]?.label ?? '';

  return (
    <figure role="group" aria-label={caption} className={cn('flex flex-col gap-2', className)}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-44 w-full"
      >
        {/* Recessive baseline */}
        <line x1={0} y1={height - 1} x2={width} y2={height - 1} className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {data.map((d, i) => {
          const barH = (d.value / max) * (height - 22);
          const x = i * slot + gap / 2;
          const y = height - barH;
          const isPeak = d.value === peak;
          return (
            <g key={d.label}>
              <path
                d={topRoundedBar(x, y, barW, barH, 4)}
                className={cn('fill-primary', isPeak ? 'opacity-100' : 'opacity-60')}
              />
              {isPeak ? (
                <text
                  x={x + barW / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="fill-content-muted text-[11px]"
                  style={{ fontSize: 11 }}
                >
                  {formatValue(d.value)}
                  {unit}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-content-subtle">
        <span>{firstLabel}</span>
        <span>{lastLabel}</span>
      </div>
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">
              Value{unit ? ` (${unit})` : ''}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{d.value.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function formatValue(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return `${value}`;
}

export interface RankedItem {
  id: string;
  label: string;
  value: number;
  meta?: string;
}

/**
 * Horizontal ranked bars rendered as a semantic table (magnitude by identity).
 * The numeric value is the accessible truth; the bar is decorative.
 */
export function RankedBarList({
  items,
  caption,
  valueLabel,
  className,
}: {
  items: RankedItem[];
  caption: string;
  valueLabel: string;
  className?: string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <table className={cn('w-full border-collapse text-sm', className)}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-xs text-content-subtle">
          <th scope="col" className="pb-2 font-medium">
            Title
          </th>
          <th scope="col" className="pb-2 text-right font-medium">
            {valueLabel}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-t border-border/60">
            <th scope="row" className="max-w-0 py-2 pr-3 text-left font-normal">
              <span className="block truncate text-content">{item.label}</span>
              {item.meta ? <span className="block truncate text-xs text-content-subtle">{item.meta}</span> : null}
            </th>
            <td className="py-2 pl-3 align-middle">
              <div className="flex items-center justify-end gap-3">
                <span aria-hidden="true" className="hidden h-2 flex-1 overflow-hidden rounded-full bg-surface-raised sm:block">
                  <span
                    className="block h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.max(4, (item.value / max) * 100)}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right tabular-nums text-content">{item.value.toLocaleString()}</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
