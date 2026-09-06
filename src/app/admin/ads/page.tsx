import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { buttonClasses } from '@/components/ui/Button';
import Link from 'next/link';

export const metadata = {
  title: 'Ads',
  description: 'Advertising placements, campaigns, and consent.',
};

/**
 * Advertising console placeholder. Kept in the nav for parity with the spec IA
 * (Section 3); the full placements/campaigns/consent surface lands in Phase 5
 * (Section 11, 19). Rendered as an explicit empty state rather than a broken link.
 */
export default function AdminAdsPage() {
  return (
    <div className="py-6">
      <PageHeader
        title="Advertising"
        description="Placements, campaigns, frequency caps, consent, and kill switches (Section 11)."
      />
      <EmptyState
        icon="◫"
        title="Advertising console arrives in Phase 5"
        description="Pre/mid/post-roll, display, native, and house promotions with per-placement and global kill switches, consent gating, and revenue metadata. The interface stays AdSense-ready without assuming approval."
        action={
          <Link href="/admin" className={buttonClasses({ variant: 'secondary', size: 'sm' })}>
            Back to dashboard
          </Link>
        }
      />
    </div>
  );
}
