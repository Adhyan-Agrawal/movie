import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import config from '../../tailwind.config';

const project = fileURLToPath(new URL('../../', import.meta.url));
const id = '10000000-0000-4000-8000-000000000001';
const notice = { id, kind: 'system', title: 'Request imported', body: 'Your requested title was added to the catalog.',
  read_at: null, created_at: '2026-11-08T03:00:00.123456+00:00' };
const feed = { status: 'ready', notifications: [notice], older: null, isOlderPage: false };
const accountLinks = [
  ['/account', 'Overview'], ['/account/profiles', 'Profiles'], ['/account/subscription', 'Subscription'],
  ['/account/watchlist', 'Watchlist'], ['/account/history', 'History'], ['/account/settings', 'Settings'],
  ['/account/devices', 'Devices'], ['/account/notifications', 'Notifications'],
];
const boundaries: Record<string, string> = {
  'next/link': `export default function Link({prefetch, ...props}) {
    return <a {...props} data-prefetch={prefetch === false ? 'false' : undefined} />;
  }`,
  'next/navigation': `
    export const useRouter = () => ({refresh: () => {window.__notifications.refreshes += 1;}});
    export const usePathname = () => window.__notifications.pathname;
  `,
  '@/lib/env': "export const features = {supabaseConfigured: false}; export const publicEnv = {NEXT_PUBLIC_APP_NAME: 'Lumora'};",
  '@/features/account/queries': `
    export const getSignedInEmail = async () => 'fixture@example.test';
    export const listAccountProfiles = async () => [{id: 'fixture-profile'}];
  `,
  '@/features/watchlist/queries': 'export const listWatchlistTitles = async () => [];',
  '@/features/playback/history-queries': 'export const listWatchHistoryWithTitles = async () => window.__notifications.history;',
  '@/features/ads/AdSlot': 'export const AdSlot = () => null;',
  '@/features/ads/ConsentGate': 'export const ConsentGate = () => null;',
  './notification-actions': `
    export const markNotificationReadAction = id => window.__notifications.request('one', id);
    export const markAllNotificationsReadAction = () => window.__notifications.request('all');
  `,
};
declare global { interface Window { __notifications: any } }
let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle: string;
let css: string;

beforeAll(async () => {
  const output = await build({
    absWorkingDir: project,
    stdin: { loader: 'tsx', resolveDir: project, contents: `
      import {createElement} from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import {NotificationsFeed} from '@/features/account/NotificationsFeed';
      import {AccountNav} from '@/features/account/AccountNav';
      import AccountOverviewPage from '@/app/account/page';
      const fixture = window.__notifications = {calls: [], refreshes: 0, pathname: '/account', history: [],
        request(kind, id) {return new Promise((resolve, reject) => this.calls.push({kind, id, resolve, reject}));}};
      const root = createRoot(document.getElementById('root'));
      fixture.render = feed => flushSync(() => root.render(createElement(NotificationsFeed, {feed})));
      fixture.renderNav = pathname => {
        fixture.pathname = pathname;
        flushSync(() => root.render(createElement(AccountNav)));
      };
      fixture.renderOverview = async history => {
        fixture.history = history;
        const element = await AccountOverviewPage();
        flushSync(() => root.render(element));
      };
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'notification-ui-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (boundaries[args.path]) return { path: args.path, namespace: 'fixture' };
        if (/^(next\/|server-only|@supabase\/|@opennextjs\/)/.test(args.path)) throw new Error(`Unmocked boundary: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path]!, loader: 'tsx', resolveDir: project }));
    } }],
  });
  bundle = output.outputFiles[0]!.text;
  // Compile only the scoped components' layout utilities, not an app/root build.
  css = (await postcss([tailwindcss({ ...config, content: [
    `${project}/src/features/account/NotificationsFeed.tsx`,
    `${project}/src/features/account/AccountNav.tsx`, `${project}/src/app/account/page.tsx`,
    `${project}/src/components/ui/Button.tsx`, `${project}/src/components/ui/EmptyState.tsx`,
  ] })]).process('@tailwind base; @tailwind utilities;', { from: undefined })).css;
  browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === 'https://notifications-ui.invalid'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' })
    : route.abort());
  page = await context.newPage();
  page.setDefaultTimeout(2_000);
  await page.goto('https://notifications-ui.invalid/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

async function render(value: unknown = feed) {
  await page.evaluate(value => window.__notifications.render(value), value);
}

describe('account link prefetch boundaries', () => {
  it.each([375, 1280])('keeps all eight account links native, focusable and non-prefetching at %ipx', async width => {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(() => window.__notifications.renderNav('/account/watchlist'));
    const nav = page.getByRole('navigation', { name: 'Account sections' });
    const links = nav.getByRole('link');
    expect(await links.evaluateAll(links => links.map(link => ({
      href: link.getAttribute('href'), label: link.textContent?.trim(),
      prefetch: link.getAttribute('data-prefetch'), current: link.getAttribute('aria-current'),
      tabIndex: (link as HTMLAnchorElement).tabIndex,
    })))).toEqual(accountLinks.map(([href, label]) => ({
      href, label, prefetch: 'false', current: href === '/account/watchlist' ? 'page' : null, tabIndex: 0,
    })));
    expect(await nav.getByRole('tab').count()).toBe(0);
    expect(await nav.locator('ul').evaluate(node => getComputedStyle(node).overflowX)).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const link of await links.all()) {
      await page.keyboard.press('Tab');
      expect(await link.evaluate(link => link === document.activeElement)).toBe(true);
      await link.scrollIntoViewIfNeeded();
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(Math.round(box!.x)).toBeGreaterThanOrEqual(0);
      expect(Math.round(box!.x + box!.width)).toBeLessThanOrEqual(width);
    }
    await page.keyboard.press('Enter');
    await page.waitForURL('https://notifications-ui.invalid/account/notifications');
  });

  it('preserves exact overview and nested-section aria-current matching', async () => {
    for (const [pathname, href] of [
      ['/account', '/account'], ['/account/profiles/new', '/account/profiles'], ['/account/settings-extra', null],
    ]) {
      await page.evaluate(pathname => window.__notifications.renderNav(pathname), pathname);
      const current = page.locator('nav[aria-label="Account sections"] a[aria-current="page"]');
      expect(await current.count()).toBe(href ? 1 : 0);
      if (href) expect(await current.getAttribute('href')).toBe(href);
    }
  });

  it('disables private overview link prefetch without changing public destinations', async () => {
    const activity = { entry: { sessionId: 'fixture-session', watchedAt: notice.created_at },
      title: { type: 'movie', slug: 'fixture-film', name: 'Fixture Film' } };
    for (const history of [[], [activity]]) {
      await page.evaluate(history => window.__notifications.renderOverview(history), history);
      expect(await page.locator('a[href^="/account"]').evaluateAll(links => links.map(link => ({
        href: link.getAttribute('href'), prefetch: link.getAttribute('data-prefetch'),
        tabIndex: (link as HTMLAnchorElement).tabIndex,
      })))).toEqual(['/account/profiles', '/account/watchlist', '/account/history'].map(href => ({
        href, prefetch: 'false', tabIndex: 0,
      })));
      const publicHref = history.length ? '/title/movie/fixture-film' : '/browse';
      const publicLink = page.locator(`a[href="${publicHref}"]`);
      expect(await publicLink.count()).toBe(1);
      expect(await publicLink.getAttribute('data-prefetch')).toBeNull();
      expect(await page.getByRole('link', { name: 'View all', exact: true }).getAttribute('href')).toBe('/account/history');
    }
  });

  it('keeps the notification recovery link native without prefetch', async () => {
    await render({ status: 'error', error: 'Could not load your notifications. Please try again.' });
    const newest = page.getByRole('link', { name: 'Newest notices', exact: true });
    expect(await newest.getAttribute('href')).toBe('/account/notifications');
    expect(await newest.getAttribute('data-prefetch')).toBe('false');
    await newest.focus();
    expect(await newest.evaluate(link => link === document.activeElement)).toBe(true);
  });
});

describe('mounted notifications feed', () => {
  it('keeps failed writes unread, then refreshes only after a successful retry', async () => {
    await render();
    const button = page.getByRole('button', { name: 'Mark Request imported as read' });
    await button.click();
    expect(await button.isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Mark all as read' }).isDisabled()).toBe(true);
    expect(await page.getByRole('status').textContent()).toContain('Updating');
    expect(await page.evaluate(() => window.__notifications.calls.map(({ kind, id }: any) => ({ kind, id })))).toEqual([{ kind: 'one', id }]);
    await page.evaluate(() => window.__notifications.calls[0].resolve({ ok: false, error: 'Please try again.' }));
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toBe('Please try again.');
    expect(await page.getByText('Unread', { exact: true }).count()).toBe(1);
    expect(await page.evaluate(() => window.__notifications.refreshes)).toBe(0);
    await button.click();
    await page.evaluate(() => window.__notifications.calls[1].resolve({ ok: true }));
    await expect.poll(() => page.evaluate(() => window.__notifications.refreshes)).toBe(1);
    expect(await page.getByRole('alert').count()).toBe(0);
    await render({ ...feed, notifications: [{ ...notice, read_at: '2026-11-08T04:00:00Z' }] });
    expect(await page.getByText('Read', { exact: true }).count()).toBe(1);
    expect(await button.count()).toBe(0);
  });

  it('marks all through the account action without sending caller-selected ownership', async () => {
    await render();
    await page.getByRole('button', { name: 'Mark all as read' }).click();
    expect(await page.evaluate(() => window.__notifications.calls.map(({ kind, id }: any) => ({ kind, id })))).toEqual([{ kind: 'all', id: undefined }]);
    await page.evaluate(() => window.__notifications.calls[0].resolve({ ok: true }));
    await expect.poll(() => page.getByRole('status').textContent()).toBe('All notifications marked as read.');
    expect(await page.evaluate(() => window.__notifications.refreshes)).toBe(1);
  });

  it('contains thrown transport failures and enables retry without optimistic success', async () => {
    await render();
    const button = page.getByRole('button', { name: 'Mark Request imported as read' });
    await button.click();
    await page.evaluate(() => window.__notifications.calls[0].reject(new Error('synthetic-private-transport-detail')));
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toBe('Could not update your notifications. Please try again.');
    expect(await button.isEnabled()).toBe(true);
    expect(await page.evaluate(() => window.__notifications.refreshes)).toBe(0);
    expect(await page.textContent('body')).not.toContain('synthetic-private');
  });

  it('has a working refresh action for load failures, not a fabricated empty inbox', async () => {
    await render({ status: 'error', error: 'Could not load your notifications. Please try again.' });
    expect(await page.getByRole('heading', { name: 'Notifications are unavailable' }).count()).toBe(1);
    expect(await page.getByRole('heading', { name: 'No notifications yet' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Try again' }).click();
    expect(await page.evaluate(() => window.__notifications.refreshes)).toBe(1);
  });

  it('links to escaped older cursors and the real newest page', async () => {
    const cursor = `${notice.created_at}|${id}`;
    await render({ ...feed, older: cursor, isOlderPage: true });
    const older = page.getByRole('link', { name: 'Older notices' });
    const newest = page.getByRole('link', { name: 'Back to newest' });
    const href = await older.getAttribute('href');
    expect(new URL(href!, 'https://notifications-ui.invalid').searchParams.get('before')).toBe(cursor);
    expect(await newest.getAttribute('href')).toBe('/account/notifications');
    for (const link of await page.getByRole('navigation', { name: 'Notification pages' }).getByRole('link').all()) {
      expect(await link.getAttribute('data-prefetch')).toBe('false');
    }
    await newest.focus();
    await page.keyboard.press('Tab');
    expect(await older.evaluate(link => link === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/account/notifications' && url.searchParams.get('before') === cursor);
  });

  it('renders an empty inbox without enabled mark-read controls', async () => {
    await render({ ...feed, notifications: [] });
    expect(await page.getByRole('heading', { name: 'No notifications yet' }).count()).toBe(1);
    expect(await page.getByRole('button').count()).toBe(0);
  });

  it.each([375, 1280])('keeps long notices and read buttons within the %ipx viewport', async (width) => {
    await page.setViewportSize({ width, height: 800 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await render({ ...feed, notifications: [{ ...notice, title: 'VeryLongTitle'.repeat(35), body: 'VeryLongNotification'.repeat(50) }] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const buttons = await page.getByRole('button').all();
    for (const button of buttons) {
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  });
});
