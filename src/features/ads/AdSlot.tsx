import { cn } from '@/lib/cn';
import { getAdSlot, type AdSlotName } from './config';
import { AdsterraBanner } from './AdsterraBanner';

/**
 * A site ad placement (Spec Section 11). Renders the Adsterra unit when the
 * slot's zone key is configured; otherwise a clearly-labeled, unobtrusive
 * placeholder so placements are visible and honestly marked.
 *
 * Server component: the env key is resolved server-side and only the banner
 * embed (Adsterra's public pattern) reaches the client.
 */
export function AdSlot({
  slot,
  className,
  /** Hide the placeholder entirely when unconfigured (default: show it). */
  silentWhenUnconfigured = false,
}: {
  slot: AdSlotName;
  className?: string;
  silentWhenUnconfigured?: boolean;
}) {
  const config = getAdSlot(slot);

  if (!config.adsterraKey) {
    if (silentWhenUnconfigured) return null;
    return (
      <div className={cn('flex w-full flex-col items-center gap-1 py-4', className)}>
        <div
          aria-label="Advertisement placeholder"
          role="complementary"
          className="flex w-full max-w-[728px] items-center justify-center rounded-md border border-dashed border-border bg-surface/30"
          style={{ height: Math.min(config.height, 90) }}
        >
          <span className="text-xs uppercase tracking-widest text-content-subtle">Advertisement</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex w-full flex-col items-center gap-1 py-4', className)}>
      <AdsterraBanner adsterraKey={config.adsterraKey} width={config.width} height={config.height} />
      <span className="text-[10px] uppercase tracking-widest text-content-subtle">Advertisement</span>
    </div>
  );
}
