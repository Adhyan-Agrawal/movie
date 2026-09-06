'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { MATURITY_LEVELS, maturityLabel, type AccountProfile } from './types';
import {
  createProfileAction,
  deleteProfileAction,
  renameProfileAction,
} from './profile-actions';

/**
 * Profile management (Spec Section 8): create, rename, and delete profiles for
 * the signed-in account, backed by real server actions (RLS-scoped). Delete is
 * a two-step inline confirmation (accessible, no modal needed); the last
 * remaining profile cannot be deleted (enforced server-side too).
 */

const FALLBACK_GRADIENT = 'linear-gradient(150deg, hsl(230 62% 46%), hsl(265 55% 30%))';

function ProfileTile({ profile }: { profile: AccountProfile }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const initial = profile.name.trim().charAt(0).toUpperCase() || '?';
  const avatar = profile.avatar?.trim() ? profile.avatar : FALLBACK_GRADIENT;

  function saveRename() {
    setError(null);
    startTransition(async () => {
      const result = await renameProfileAction(profile.id, name);
      if (!result.ok) setError(result.error ?? 'Rename failed.');
      else {
        setEditing(false);
        router.refresh();
      }
    });
  }

  function doDelete() {
    setError(null);
    startTransition(async () => {
      const result = await deleteProfileAction(profile.id);
      if (!result.ok) {
        setError(result.error ?? 'Delete failed.');
        setConfirmDelete(false);
      } else {
        router.refresh();
      }
    });
  }

  return (
    <li className="flex flex-col items-center gap-3">
      <div
        aria-hidden="true"
        className="grid aspect-square w-full max-w-[8.5rem] place-items-center overflow-hidden rounded-lg border border-border shadow-soft"
        style={avatar.startsWith('linear-gradient') ? { backgroundImage: avatar } : undefined}
      >
        <span className="grid h-full w-full place-items-center font-display text-4xl font-bold text-white/90 drop-shadow">
          {initial}
        </span>
      </div>

      {editing ? (
        <div className="flex w-full max-w-[8.5rem] flex-col gap-1.5">
          <label htmlFor={`rename-${profile.id}`} className="sr-only">
            Rename {profile.name}
          </label>
          <input
            id={`rename-${profile.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            className="h-9 rounded-md border border-border bg-surface-raised px-2 text-center text-sm text-content focus-visible:outline-none focus-visible:border-primary"
          />
          <div className="flex justify-center gap-1">
            <Button size="sm" variant="primary" disabled={pending} onClick={saveRename}>
              Save
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setEditing(false); setName(profile.name); setError(null); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-sm font-medium text-content">{profile.name}</span>
          {profile.isKids ? <Badge tone="info">Kids</Badge> : <Badge tone="neutral">{maturityLabel(profile.maturityCeiling)}</Badge>}
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Rename
            </Button>
            {confirmDelete ? (
              <>
                <Button size="sm" variant="secondary" disabled={pending} onClick={doDelete}>
                  Confirm delete
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmDelete(false)}>
                  No
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="max-w-[10rem] text-center text-xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function ProfileManager({ profiles }: { profiles: AccountProfile[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [isKids, setIsKids] = useState(false);
  const [ceiling, setCeiling] = useState('adults');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createProfileAction({ name, isKids, maturityCeiling: ceiling });
      if (!result.ok) setError(result.error ?? 'Could not create the profile.');
      else {
        setName('');
        setIsKids(false);
        setCeiling('adults');
        router.refresh();
      }
    });
  }

  return (
    <section aria-labelledby="profiles-heading" className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 id="profiles-heading" className="text-lg font-semibold">
          Your profiles
        </h2>
        <p className="text-sm text-content-muted">
          {profiles.length} {profiles.length === 1 ? 'profile' : 'profiles'} on this account. Each keeps its own
          watchlist and viewing history.
        </p>
      </div>

      <ul className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {profiles.map((profile) => (
          <ProfileTile key={profile.id} profile={profile} />
        ))}
      </ul>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
        className="flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-surface/40 p-4"
        aria-labelledby="new-profile-heading"
      >
        <h3 id="new-profile-heading" className="text-sm font-semibold">
          Add a profile
        </h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-profile-name" className="text-xs text-content-muted">
              Name
            </label>
            <input
              id="new-profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
              placeholder="e.g. Movie night"
              className="h-11 w-48 rounded-md border border-border bg-surface-raised px-3 text-sm text-content placeholder:text-content-subtle focus-visible:outline-none focus-visible:border-primary"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-profile-maturity" className="text-xs text-content-muted">
              Maturity level
            </label>
            <select
              id="new-profile-maturity"
              value={ceiling}
              onChange={(e) => setCeiling(e.target.value)}
              disabled={isKids}
              className={cn(
                'h-11 rounded-md border border-border bg-surface-raised px-3 text-sm text-content focus-visible:outline-none focus-visible:border-primary',
                isKids && 'opacity-50',
              )}
            >
              {MATURITY_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label} — {level.description}
                </option>
              ))}
            </select>
          </div>
          <label className="flex h-11 items-center gap-2 text-sm text-content-muted">
            <input
              type="checkbox"
              checked={isKids}
              onChange={(e) => setIsKids(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Kids profile
          </label>
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating…' : 'Add profile'}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
