import { cn } from '@/lib/cn';

/**
 * Inline-SVG sparkline for the admin stat tiles.
 *
 * Design follows the dataviz method: thin marks, a single hue for magnitude,
 * and a decorative mark only (callers supply text) so identity/values are
 * never conveyed by color or shape alone. Pure presentational component (no
 * hooks) — usable in Server or Client Components alike.
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
