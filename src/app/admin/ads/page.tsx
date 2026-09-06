import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { adSlotStatuses, adsConfigured } from '@/features/ads/config';
import { listAdminAdPlacements } from '@/features/admin/queries';

export const metadata = {
  title: 'Ads',
  description: 'Advertising placements, providers, and configuration.',
};

/**
 * Advertising console (Spec Section 11): Adsterra zone configuration status for
 * every public placement. Zone keys live in server env (see .env.example) —
 * this surface shows which slots are live vs placeholder, and reads the
 * placement rows from the DB (enabled flags). Campaign/creative management and
 * impression reporting arrive with the commercial phase.
 */
export default async function AdminAdsPage() {
  const slots = adSlotStatuses();
  const configured = adsConfigured();
  // Degrade to "not seeded" if the read fails — the env status above is the
  // operative truth for whether ads serve.
  const placements = await listAdminAdPlacements().catch(() => []);

  return (
    <div className="flex flex-col gap-8 py-6">
      <PageHeader
        title="Advertising"
        description="Adsterra placements across the site — below-the-fold banners plus one skippable player pre-roll."
      />

      <section aria-labelledby="ads-provider" className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 id="ads-provider" className="text-lg font-semibold">
            Provider
          </h2>
          <Badge tone={configured ? 'success' : 'warning'}>
            {configured ? 'Adsterra live' : 'Adsterra unconfigured'}
          </Badge>
        </div>
        <p className="max-w-2xl text-sm leading-relaxed text-content-muted">
          {configured
            ? 'At least one Adsterra zone key is configured — those slots serve live ads; the rest show labeled placeholders until configured.'
            : 'No Adsterra zone keys are set. Every slot currently renders a labeled “Advertisement” placeholder. Add your zone keys from the Adsterra dashboard (Websites → your zone → atOptions.key) to .env as ADSTERRA_KEY_LEADERBOARD, ADSTERRA_KEY_RECTANGLE, and ADSTERRA_KEY_PREROLL, then restart the server.'}
        </p>
      </section>

      <section aria-labelledby="ads-slots" className="flex flex-col gap-3">
        <h2 id="ads-slots" className="text-lg font-semibold">
          Placements
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wider text-content-subtle">
              <tr>
                <th className="px-4 py-3">Slot</th>
                <th className="px-4 py-3">Key</th>
                <th className="px-4 py-3">Format</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {slots.map((slot) => (
                <tr key={slot.key}>
                  <td className="px-4 py-3 font-medium">{slot.label}</td>
                  <td className="px-4 py-3 font-mono text-xs text-content-muted">{slot.key}</td>
                  <td className="px-4 py-3 text-content-muted">{slot.format}</td>
                  <td className="px-4 py-3">
                    <Badge tone={slot.configured ? 'success' : 'neutral'}>
                      {slot.configured ? 'Live' : 'Placeholder'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {placements.length > 0 ? (
          <p className="text-xs text-content-subtle">
            {placements.length} placement row{placements.length === 1 ? '' : 's'} in the database — per-placement
            enable/disable toggles and frequency caps arrive with the commercial phase.
          </p>
        ) : (
          <p className="text-xs text-content-subtle">
            Placement rows aren&apos;t seeded yet — <Link href="/admin/sync" className="text-primary hover:underline">catalog sync</Link>{' '}
            and placement seeding are the current operational tools.
          </p>
        )}
      </section>

      <section aria-labelledby="ads-policy" className="flex flex-col gap-2">
        <h2 id="ads-policy" className="text-lg font-semibold">
          Policy
        </h2>
        <ul className="max-w-2xl list-inside list-disc text-sm leading-relaxed text-content-muted">
          <li>Below-the-fold banners only — never between the user and the Play action.</li>
          <li>One skippable pre-roll (5s countdown) per tab session on the player.</li>
          <li>No popunders, navigation interstitials, or social-bar formats.</li>
          <li>Ads require viewer consent where applicable (see the site consent banner) and respect the global kill switch planned for this console.</li>
        </ul>
      </section>
    </div>
  );
}
