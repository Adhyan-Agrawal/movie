'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { ConfirmDialog } from './ConfirmDialog';
import { ProfileCard } from './ProfileCard';
import type { Profile } from './mock';

const MAX_PROFILES = 5;

function AddProfileTile({ onClick }: { onClick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        aria-label="Add a profile"
        className={cn(
          'grid aspect-square w-full max-w-[8.5rem] place-items-center rounded-lg border border-dashed border-border-strong text-content-muted',
          'transition-colors duration-200 ease-deliberate hover:border-primary hover:text-content',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        )}
      >
        <span aria-hidden="true" className="text-4xl font-light">
          +
        </span>
      </button>
      <span className="text-sm font-medium text-content-muted">Add profile</span>
    </div>
  );
}

/**
 * Netflix-style profile picker (Section 4). Includes an add-profile tile and,
 * in "manage" mode, edit + delete affordances. Deleting a profile is a
 * destructive action, so it routes through the accessible ConfirmDialog.
 */
export function ProfileGrid({ profiles: initialProfiles }: { profiles: Profile[] }) {
  const [profiles, setProfiles] = useState<Profile[]>(initialProfiles);
  const [manage, setManage] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Profile | null>(null);
  const [status, setStatus] = useState('');

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    setPendingDelete(null);
    setManage(false);
    setStatus(`${name}’s profile was deleted.`);
  };

  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="profiles-heading" className="text-lg font-semibold">
            Who’s watching?
          </h2>
          <p className="text-sm text-content-muted">
            {profiles.length} of {MAX_PROFILES} profiles. Select a profile to switch, or manage details.
          </p>
        </div>
        <Button variant="secondary" size="sm" aria-pressed={manage} onClick={() => setManage((m) => !m)}>
          {manage ? 'Done' : 'Manage profiles'}
        </Button>
      </div>

      <ul className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {profiles.map((profile) => (
          <li key={profile.id}>
            <ProfileCard
              profile={profile}
              manage={manage}
              onSelect={() => setStatus(`Switched to ${profile.name}.`)}
              onEdit={() => setStatus('Editing profiles isn’t available in this sample.')}
              onDelete={() => setPendingDelete(profile)}
            />
          </li>
        ))}
        {!manage && profiles.length < MAX_PROFILES ? (
          <li>
            <AddProfileTile onClick={() => setStatus('Adding a profile isn’t available in this sample.')} />
          </li>
        ) : null}
      </ul>

      <p aria-live="polite" className="sr-only">
        {status}
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title="Delete this profile?"
        description={
          pendingDelete
            ? `“${pendingDelete.name}” and its watchlist, history, and recommendations will be permanently removed. This can’t be undone.`
            : undefined
        }
        confirmLabel="Delete profile"
        cancelLabel="Keep profile"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
