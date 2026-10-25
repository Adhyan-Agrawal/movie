import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPLETION_THRESHOLD,
  RESUME_MIN_PROGRESS,
  isResumable,
  progressFraction,
} from '@/features/playback/progress';
import { getPlaybackContext, getResumePosition } from '@/features/playback/progress-queries';
import { reportProgressAction } from '@/features/playback/progress-actions';
import { getSupabaseServerClient, type SupabaseServerClient } from '@/lib/supabase/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: vi.fn() }));
vi.mock('@/features/watchlist/queries', () => ({ getDefaultProfileId: vi.fn() }));
vi.mock('@/features/catalog/queries', () => ({ getTitleById: vi.fn() }));

// Fluent DB doubles only. No request reaches Supabase or mutates a database.
function queryResult(data: unknown, error: { message: string } | null = null) {
  const result = { data, error };
  const query = {
    select: vi.fn(), eq: vi.fn(), is: vi.fn(), order: vi.fn(), limit: vi.fn(),
    update: vi.fn(), insert: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  for (const method of [query.select, query.eq, query.is, query.order, query.limit, query.update, query.insert]) {
    method.mockReturnValue(query);
  }
  return query;
}

function installDatabase(options: {
  accountId?: string | null;
  authError?: { name: string } | null;
  profiles?: Array<{ id: string }>;
  profileError?: { message: string };
  progress?: unknown;
  progressError?: { message: string };
  episode?: unknown;
} = {}) {
  const accountId = options.accountId === undefined ? 'a' : options.accountId;
  const profiles = queryResult(options.profiles ?? [{ id: 'p' }], options.profileError);
  const progress = queryResult(options.progress ?? null, options.progressError);
  const episode = queryResult(options.episode === undefined ? { id: 'ep1' } : options.episode);
  const db = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: accountId ? { id: accountId } : null }, error: options.authError ?? null }) },
    from: vi.fn((table: string) => {
      if (table === 'profiles') return profiles;
      if (table === 'watch_progress') return progress;
      if (table === 'episodes') return episode;
      throw new Error(`Unexpected table: ${table}`);
    }),
  };
  vi.mocked(getSupabaseServerClient).mockResolvedValue(db as unknown as SupabaseServerClient);
  return { db, profiles, progress, episode };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

/**
 * The progress policy is pure math with product meaning: a fabricated 50% on
 * an unknown duration would be a lie on the home row, and resuming a finished
 * title would be a bad default. These tests pin both rules.
 */

describe('progressFraction', () => {
  it('computes a 0..1 fraction from position and duration', () => {
    expect(progressFraction(60, 120)).toBeCloseTo(0.5);
    expect(progressFraction(0, 120)).toBe(0);
    expect(progressFraction(119, 120)).toBeCloseTo(0.9917);
  });

  it('clamps beyond-full playback to 1', () => {
    expect(progressFraction(300, 120)).toBe(1);
  });

  it('returns 0 for unknown, zero, or invalid durations — never a guess', () => {
    expect(progressFraction(60, undefined)).toBe(0);
    expect(progressFraction(60, 0)).toBe(0);
    expect(progressFraction(60, Number.NaN)).toBe(0);
    expect(progressFraction(60, -10)).toBe(0);
  });

  it('returns 0 for missing or invalid positions', () => {
    expect(progressFraction(Number.NaN, 120)).toBe(0);
    expect(progressFraction(-5, 120)).toBe(0);
  });
});

describe('isResumable', () => {
  it('resumes mid-watch positions', () => {
    expect(isResumable(0.5)).toBe(true);
    expect(isResumable(RESUME_MIN_PROGRESS)).toBe(true);
  });

  it('does not resume barely-started or finished titles', () => {
    expect(isResumable(0)).toBe(false);
    expect(isResumable(0.01)).toBe(false);
    expect(isResumable(COMPLETION_THRESHOLD)).toBe(false);
    expect(isResumable(1)).toBe(false);
  });
});

describe('getPlaybackContext exact resume', () => {
  const updated_at = '2026-10-25T00:00:00.000Z';

  it.each([0, 0.001, 0.01, 0.5, 0.99, 1])('resumes positive positions independent of catalog progress %s', async (progress) => {
    const { profiles, progress: query } = installDatabase({ progress: { position_seconds: 7, progress, updated_at } });
    expect(await getPlaybackContext('title1', 'ep1')).toEqual({
      viewerKey: 'account:a:profile:p',
      resumePosition: { positionSeconds: 7, progress, updatedAt: Date.parse(updated_at) },
    });
    expect(profiles.eq).toHaveBeenCalledWith('account_id', 'a');
    expect(query.eq).toHaveBeenCalledWith('account_id', 'a');
    expect(query.eq).toHaveBeenCalledWith('profile_id', 'p');
    expect(query.eq).toHaveBeenCalledWith('title_id', 'title1');
    expect(query.eq).toHaveBeenCalledWith('episode_id', 'ep1');
  });

  it('keeps the existing getResumePosition API and exact movie null-episode scoping', async () => {
    const { progress } = installDatabase({ progress: { position_seconds: 4, progress: 0, updated_at } });
    expect(await getResumePosition('title1')).toEqual({ positionSeconds: 4, progress: 0, updatedAt: Date.parse(updated_at) });
    expect(progress.is).toHaveBeenCalledWith('episode_id', null);
  });

  it.each([
    { position_seconds: 0, progress: 0, updated_at },
    { position_seconds: -1, progress: 0, updated_at },
    { position_seconds: Number.NaN, progress: 0, updated_at },
    { position_seconds: Infinity, progress: 0, updated_at },
    { position_seconds: 2_147_483_648, progress: 0, updated_at },
    { position_seconds: 4, progress: Number.NaN, updated_at },
    { position_seconds: 4, progress: -0.1, updated_at },
    { position_seconds: 4, progress: 1.1, updated_at },
    { position_seconds: 4, progress: 0, updated_at: 'invalid' },
  ])('ignores corrupt/empty saved positions %#', async (progress) => {
    installDatabase({ progress });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'account:a:profile:p', resumePosition: null });
  });

  it('uses guest only for genuinely absent verified sessions', async () => {
    const { db } = installDatabase({ accountId: null });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'guest', resumePosition: null });
    expect(db.from).not.toHaveBeenCalled();
    installDatabase({ accountId: null, authError: { name: 'AuthSessionMissingError' } });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'guest', resumePosition: null });
  });

  it.each(['AuthRetryableFetchError', 'AuthApiError', 'AuthUnknownError'])('does not turn uncertain auth %s into guest', async (name) => {
    installDatabase({ accountId: null, authError: { name } });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'unavailable', resumePosition: null });
  });

  it('preserves account isolation for verified users without a profile', async () => {
    const { db } = installDatabase({ accountId: 'no-profile', profiles: [] });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'account:no-profile', resumePosition: null });
    expect(db.from).not.toHaveBeenCalledWith('watch_progress');
  });

  it('does not trust a user object accompanying an auth verification error', async () => {
    installDatabase({ accountId: 'a', authError: { name: 'AuthApiError' } });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'unavailable', resumePosition: null });
  });

  it('never falls back to guests on profile/progress/client failures', async () => {
    installDatabase({ profileError: { message: 'unavailable' } });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'unavailable', resumePosition: null });
    installDatabase({ progressError: { message: 'unavailable' } });
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'account:a:profile:p', resumePosition: null });
    vi.mocked(getSupabaseServerClient).mockRejectedValue(new Error('unavailable'));
    expect(await getPlaybackContext('title1')).toEqual({ viewerKey: 'unavailable', resumePosition: null });
  });
});

describe('reportProgressAction scope and validation', () => {
  it.each([Number.NaN, Infinity, -Infinity, -1, 2_147_483_648, '4' as unknown as number])(
    'rejects invalid server numeric input %s before any DB access', async (value) => {
      expect(await reportProgressAction({ titleId: 'title1', positionSeconds: value })).toEqual({ ok: false });
      expect(await reportProgressAction({ titleId: 'title1', positionSeconds: 4, durationSeconds: value })).toEqual({ ok: false });
      expect(getSupabaseServerClient).not.toHaveBeenCalled();
    },
  );

  it.each(['guest', 'unavailable', 'account:b:profile:p', 'account:a:profile:other', 'account:a']) (
    'rejects a caller viewerKey mismatch %s without using it as authority', async (viewerKey) => {
      const { db } = installDatabase();
      expect(await reportProgressAction({ titleId: 'title1', positionSeconds: 4, viewerKey })).toEqual({ ok: false });
      expect(db.from).not.toHaveBeenCalledWith('watch_progress');
    },
  );

  it('supports omitted viewerKey and inserts only actual account/profile identity', async () => {
    const { progress } = installDatabase();
    expect(await reportProgressAction({ titleId: 'title1', positionSeconds: 4.4, durationSeconds: 100 })).toEqual({ ok: true });
    expect(progress.is).toHaveBeenCalledWith('episode_id', null);
    expect(progress.insert).toHaveBeenCalledWith({
      account_id: 'a', profile_id: 'p', title_id: 'title1', position_seconds: 4,
      duration_seconds: 100, progress: 0.04, completed: false,
    });
  });

  it('updates with matching scope, exact episode and account/profile filters', async () => {
    const { progress, episode } = installDatabase({ progress: { id: 'row1' } });
    expect(await reportProgressAction({ titleId: 'title1', episodeId: 'ep1', positionSeconds: 7, viewerKey: 'account:a:profile:p' })).toEqual({ ok: true });
    expect(episode.eq).toHaveBeenCalledWith('id', 'ep1');
    expect(episode.eq).toHaveBeenCalledWith('title_id', 'title1');
    expect(progress.eq).toHaveBeenCalledWith('episode_id', 'ep1');
    expect(progress.eq).toHaveBeenCalledWith('account_id', 'a');
    expect(progress.eq).toHaveBeenCalledWith('profile_id', 'p');
    expect(progress.eq).toHaveBeenCalledWith('id', 'row1');
    expect(progress.update).toHaveBeenCalledWith(expect.objectContaining({ position_seconds: 7, progress: 0, completed: false }));
  });

  it('rejects an episode not belonging to the requested title', async () => {
    const { db, episode } = installDatabase({ episode: null });
    expect(await reportProgressAction({ titleId: 'title1', episodeId: 'other-title-episode', positionSeconds: 4 })).toEqual({ ok: false });
    expect(episode.eq).toHaveBeenCalledWith('title_id', 'title1');
    expect(db.from).not.toHaveBeenCalledWith('watch_progress');
  });

  it('returns failure on auth/profile/DB failures without writing guest storage', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    try {
      for (const options of [
        { accountId: null }, { authError: { name: 'AuthRetryableFetchError' } },
        { profiles: [] }, { profileError: { message: 'unavailable' } },
        { progressError: { message: 'unavailable' } },
      ]) {
        installDatabase(options);
        expect(await reportProgressAction({ titleId: 'title1', positionSeconds: 4 })).toEqual({ ok: false });
      }
      vi.mocked(getSupabaseServerClient).mockRejectedValue(new Error('unavailable'));
      expect(await reportProgressAction({ titleId: 'title1', positionSeconds: 4 })).toEqual({ ok: false });
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
