'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/Button';
import { saveVastAction } from './actions';
import { CommerceCredentials, CommerceFeedback, commerceInputClass } from './CommerceFields';
import type { VastConfiguration } from './types';

/** Private configuration is rendered only behind the server ads.manage gate. */
export function VastSettingsForm({ config }: { config: VastConfiguration }) {
  const [state, action, pending] = useActionState(saveVastAction, { ok: false });
  return <form action={action} className="flex flex-col gap-5 rounded-lg border border-border bg-surface/40 p-5">
    <label className="flex items-center gap-2 font-medium"><input name="enabled" type="checkbox" defaultChecked={config.enabled} />Enable playback VAST advertising</label>
    <p className="text-sm text-content-muted">Disabled by default. Unresolved entitlements, paid ad-free access, invalid settings, and unavailable configuration suppress playback ads.</p>
    <label className="flex flex-col gap-1 text-sm">Private VAST tag URL (public HTTPS endpoint)
      <input name="tagUrl" type="url" defaultValue={config.tagUrl} maxLength={4096} autoComplete="off" spellCheck={false} className={commerceInputClass} />
    </label>
    <label className="flex flex-col gap-1 text-sm">Allowed public hosts (one exact hostname per line)
      <textarea name="allowedHosts" defaultValue={config.allowedHosts.join('\n')} maxLength={7620} rows={4} spellCheck={false} className={commerceInputClass} />
    </label>
    <p className="text-xs text-content-muted">No IP addresses, wildcards, credentials, private hosts, fragments or non-HTTPS tags. Include trusted wrapper, media and tracking hosts. Public playback responses never include the tag URL.</p>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-sm">First break after content seconds
        <input name="firstBreakSeconds" type="number" min={60} max={86400} step={1} required defaultValue={config.firstBreakSeconds} className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Interval between breaks (seconds)
        <input name="intervalSeconds" type="number" min={60} max={86400} step={1} required defaultValue={config.intervalSeconds} className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Maximum breaks per playback
        <input name="maxBreaks" type="number" min={0} max={20} step={1} required defaultValue={config.maxBreaks} className={commerceInputClass} />
      </label>
      <label className="flex flex-col gap-1 text-sm">Skip countdown (seconds)
        <input name="skipAfterSeconds" type="number" min={0} max={30} step={1} required defaultValue={config.skipAfterSeconds} className={commerceInputClass} />
      </label>
    </div>
    <label className="flex items-center gap-2 text-sm"><input name="allowSkip" type="checkbox" defaultChecked={config.allowSkip} />Allow skipping after the configured countdown</label>
    <CommerceCredentials /><CommerceFeedback state={state} />
    <Button type="submit" disabled={pending} className="self-start">{pending ? 'Saving...' : 'Save VAST configuration'}</Button>
  </form>;
}
