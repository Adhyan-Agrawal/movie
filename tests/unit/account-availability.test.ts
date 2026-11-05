import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  features: { supabaseConfigured: false },
  client: vi.fn(), profile: vi.fn(), signin: vi.fn(), signup: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ features: mocks.features }));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseServerClient: mocks.client }));
vi.mock('@/features/watchlist/queries', () => ({ getDefaultProfileId: mocks.profile }));
vi.mock('@/features/auth/SignInForm', () => ({ SignInForm: () => { mocks.signin(); return 'SIGNIN_FORM'; } }));
vi.mock('@/features/auth/SignUpForm', () => ({ SignUpForm: () => { mocks.signup(); return 'SIGNUP_FORM'; } }));
vi.mock('next/navigation', () => ({ usePathname: () => '/title/movie/fixture' }));
vi.mock('next/link', async () => {
  const React = await import('react');
  return { default: (props: any) => React.createElement('a', { href: props.href, className: props.className, 'aria-label': props['aria-label'] }, props.children) };
});

import { toggleWatchlistAction } from '@/features/watchlist/actions';
import { setRatingAction, removeRatingAction } from '@/features/catalog/ratings-actions';
import { submitTitleRequestAction } from '@/features/catalog/requests-actions';
import { reportPlaybackIssueAction } from '@/features/playback/report-actions';
import SignInPage from '@/app/signin/page';
import SignUpPage from '@/app/signup/page';
import { WatchlistButton } from '@/features/catalog/components/WatchlistButton';
import { RatingControl } from '@/features/catalog/components/RatingControl';
import { ACCOUNT_SERVICES_UNAVAILABLE } from '@/features/account/availability';

const titleId = '123e4567-e89b-42d3-a456-426614174000';
function requestForm() {
  const form = new FormData();
  form.set('title_name', 'Synthetic fixture'); form.set('media_type', 'movie');
  return form;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.features.supabaseConfigured = false;
  mocks.client.mockRejectedValue(new Error('https://private.example/?secret=do-not-expose'));
});

describe('unavailable account service release gates', () => {
  it('performs no database, auth, or profile calls when account services are unconfigured', async () => {
    await expect(toggleWatchlistAction(titleId, true)).resolves.toMatchObject({ ok: false, inWatchlist: true, error: ACCOUNT_SERVICES_UNAVAILABLE });
    await expect(setRatingAction(titleId, 8)).resolves.toEqual({ ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE });
    await expect(removeRatingAction(titleId)).resolves.toEqual({ ok: false, message: ACCOUNT_SERVICES_UNAVAILABLE });
    await expect(submitTitleRequestAction({}, requestForm())).resolves.toMatchObject({ status: 'error', message: ACCOUNT_SERVICES_UNAVAILABLE });
    await expect(reportPlaybackIssueAction({ titleId })).resolves.toEqual({ ok: false });
    expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
  });

  it('turns thrown configured-backend failures into ordinary sanitized results', async () => {
    mocks.features.supabaseConfigured = true;
    const results = await Promise.all([
      toggleWatchlistAction(titleId, false), setRatingAction(titleId, 8), removeRatingAction(titleId),
      submitTitleRequestAction({}, requestForm()), reportPlaybackIssueAction({ titleId }),
    ]);
    expect(results.every((result: any) => result.ok === false || result.status === 'error')).toBe(true);
    expect(JSON.stringify(results)).not.toMatch(/private\.example|do-not-expose|secret=/);
  });

  it('never attempts account storage for public virtual title identities', async () => {
    mocks.features.supabaseConfigured = true;
    await toggleWatchlistAction('tmdb:movie:27205', false);
    await setRatingAction('tmdb:movie:27205', 8);
    await removeRatingAction('tmdb:movie:27205');
    await reportPlaybackIssueAction({ titleId: 'tmdb:movie:27205' });
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('renders unavailable auth pages rather than active forms or fabricated confirmation', async () => {
    const signin = renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({ confirmed: '1', email: 'fixture@example.test' }) }));
    const signup = renderToStaticMarkup(SignUpPage());
    for (const html of [signin, signup]) {
      expect(html).toContain('Accounts are unavailable');
      expect(html).toContain(ACCOUNT_SERVICES_UNAVAILABLE);
      expect(html).not.toContain('<form');
    }
    expect(signin).not.toContain('Check <span');
    expect(mocks.signin).not.toHaveBeenCalled(); expect(mocks.signup).not.toHaveBeenCalled();
  });

  it('preserves configured form rendering', async () => {
    mocks.features.supabaseConfigured = true;
    expect(renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }))).toContain('SIGNIN_FORM');
    expect(renderToStaticMarkup(SignUpPage())).toContain('SIGNUP_FORM');
  });

  it('disables unavailable watchlist and rating controls without losing the public summary', () => {
    const watchlist = renderToStaticMarkup(createElement(WatchlistButton, { titleId, titleName: 'Fixture', available: false }));
    expect(watchlist).toContain('Watchlist unavailable'); expect(watchlist).toContain('disabled=""');
    const rating = renderToStaticMarkup(createElement(RatingControl, { titleId, initialMyRating: null, average: 7.8, count: 20, available: false }));
    expect(rating).toContain('7.8'); expect(rating).toContain('Personal ratings unavailable');
    expect(rating.match(/disabled=""/g)).toHaveLength(5);
  });
});
