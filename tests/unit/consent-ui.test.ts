import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createElement, Fragment, type AnchorHTMLAttributes } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ prefetch: _prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) => createElement('a', props) }));
vi.mock('@/lib/env', () => ({ publicEnv: { NEXT_PUBLIC_APP_NAME: 'Lumora' } }));

import { ConsentBanner, readConsent as legacyReadConsent } from '@/components/consent/ConsentBanner';
import { ConsentGate } from '@/features/ads/ConsentGate';
import { AdsterraBanner } from '@/features/ads/AdsterraBanner';
import { readConsent, subscribeConsent, writeConsent, type ConsentChoice } from '@/lib/consent';

const project = fileURLToPath(new URL('../../', import.meta.url));
const storageKey = 'lumora.consent.v1';
const granted: ConsentChoice = { necessary: true, analytics: true, ads: true, decidedAt: '2026-11-07T06:00:00.000Z' };
const denied: ConsentChoice = { ...granted, analytics: false, ads: false };

const boundaries: Record<string, string> = {
  'next/link': `export default function Link({prefetch, ...props}) {
    return <a {...props} data-prefetch={prefetch === false ? 'false' : undefined} />;
  }`,
  '@/lib/env': "export const publicEnv = { NEXT_PUBLIC_APP_NAME: 'Lumora' };",
};

// Real React DOM, consent components and ad iframes; every request is fulfilled or blocked locally.
const entry = `
  import {Fragment, StrictMode, useEffect} from 'react';
  import {createRoot, hydrateRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import {ConsentBanner, readConsent as legacyReadConsent} from '@/components/consent/ConsentBanner';
  import {ConsentGate} from '@/features/ads/ConsentGate';
  import {AdsterraBanner} from '@/features/ads/AdsterraBanner';
  import {Footer} from '@/components/shell/Footer';
  import {readConsent, writeConsent, subscribeConsent} from '@/lib/consent';
  const fixture = window.__consentUI = {readConsent, writeConsent, subscribeConsent,
    legacyReadConsent, errors: [], activeAds: 0, notifications: []};
  const reportError = console.error.bind(console);
  console.error = (...args) => {
    fixture.errors.push(args.map(value => value?.message ?? String(value)).join(' '));
    reportError(...args);
  };
  window.addEventListener('error', event => fixture.errors.push(event.message));
  window.addEventListener('unhandledrejection', event => fixture.errors.push(String(event.reason)));
  function Ad({id}) {
    useEffect(() => { fixture.activeAds++; return () => { fixture.activeAds--; }; }, []);
    return <AdsterraBanner adsterraKey={'fixture-' + id} width={728} height={90} mobileWidth={320} mobileHeight={50} />;
  }
  function App() {
    return <><ConsentBanner />{[1, 2].map(id => <ConsentGate key={id}><Ad id={id} /></ConsentGate>)}</>;
  }
  let root;
  const options = {onRecoverableError: error => fixture.errors.push(error.message),
    onUncaughtError: error => fixture.errors.push(error.message)};
  fixture.render = (mode = 'consent', hydrate = false, strict = false) => {
    const Wrapper = strict ? StrictMode : Fragment;
    const element = <Wrapper>{mode === 'footer' ? <Footer /> : <App />}</Wrapper>;
    if (hydrate) { root = hydrateRoot(document.getElementById('root'), element, options); return; }
    root ??= createRoot(document.getElementById('root'), options);
    flushSync(() => root.render(element));
  };
  fixture.unmount = () => { flushSync(() => root?.unmount()); root = undefined; };
`;

declare global {
  interface Window {
    __consentUI: {
      readConsent: typeof readConsent;
      legacyReadConsent: typeof readConsent;
      writeConsent: typeof writeConsent;
      subscribeConsent: typeof subscribeConsent;
      render: (mode?: 'consent' | 'footer', hydrate?: boolean, strict?: boolean) => void;
      unmount: () => void;
      errors: string[];
      activeAds: number;
      notifications: Array<ConsentChoice | null>;
    };
  }
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle: string;
let adRequests: number;

beforeAll(async () => {
  const result = await build({
    absWorkingDir: project, stdin: { contents: entry, loader: 'tsx', resolveDir: project },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'consent-test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        if (boundaries[args.path]) return { path: args.path, namespace: 'fixture' };
        if (/^(next\/|server-only|@supabase\/|@opennextjs\/)/.test(args.path)) throw new Error(`Unmocked framework boundary: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: boundaries[args.path]!, loader: 'tsx', resolveDir: project }));
    } }],
  });
  bundle = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => {
  adRequests = 0;
  context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://consent-ui.invalid' && url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><div id="root"></div></body></html>' });
    }
    if (url.origin === 'https://consent-ui.invalid' && url.pathname === '/api/ad-frame') {
      adRequests++;
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>Synthetic advertisement</body></html>' });
    }
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(3000);
  await page.goto('https://consent-ui.invalid/');
  await page.addScriptTag({ content: bundle });
});
afterEach(async () => {
  try { expect(await page.evaluate(() => window.__consentUI.errors)).toEqual([]); }
  finally { await context?.close(); }
});
afterAll(async () => { await browser?.close(); });

async function render(strict = false) {
  await page.evaluate(strict => window.__consentUI.render('consent', false, strict), strict);
}
async function expectAds(count: number) {
  await expect.poll(() => page.locator('iframe[title^="Advertisement"]').count()).toBe(count);
  await expect.poll(() => page.evaluate(() => window.__consentUI.activeAds)).toBe(count);
}
async function storeRaw(raw: string | null, tab = page) {
  await tab.evaluate(({ key, raw }) => {
    if (raw === null) localStorage.removeItem(key);
    else localStorage.setItem(key, raw);
  }, { key: storageKey, raw });
}

describe('mounted consent gates', () => {
  it.each([
    { strict: false, width: 1280, motion: 'no-preference' as const, adWidth: '728' },
    { strict: true, width: 375, motion: 'reduce' as const, adWidth: '320' },
  ])('loads mounted slots only after Accept all at $width px with motion=$motion', async ({ strict, width, motion, adWidth }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.emulateMedia({ reducedMotion: motion });
    await render(strict);
    await expectAds(0);
    expect(adRequests).toBe(0);
    expect(await page.getByRole('dialog', { name: 'Privacy consent' }).count()).toBe(1);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await expectAds(2);
    await expect.poll(() => adRequests).toBe(2);
    expect(await page.locator('iframe').first().getAttribute('width')).toBe(adWidth);
    expect(await page.getByRole('dialog').count()).toBe(0);
    expect(await page.evaluate(() => window.__consentUI.legacyReadConsent())).toMatchObject({ necessary: true, ads: true, analytics: true });
  });

  it('saves granular advertising consent without requiring analytics', async () => {
    await render();
    await page.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('checkbox', { name: 'Analytics consent', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: 'Advertising consent', exact: true }).check();
    expect(adRequests).toBe(0);
    await page.getByRole('button', { name: 'Save choices' }).click();
    await expectAds(2);
    expect(await page.evaluate(() => window.__consentUI.readConsent())).toMatchObject({ ads: true, analytics: false });
  });

  it('never loads slots when rejecting non-essential consent', async () => {
    await render();
    await page.getByRole('button', { name: 'Reject non-essential' }).click();
    expect(await page.getByRole('dialog').count()).toBe(0);
    await expectAds(0);
    expect(adRequests).toBe(0);
    expect(await page.evaluate(() => window.__consentUI.readConsent())).toMatchObject({ ads: false, analytics: false });
  });

  it.each([null, denied])('unmounts loaded ads on a same-tab revocation (%j)', async choice => {
    await storeRaw(JSON.stringify(granted)); await render(); await expectAds(2);
    await expect.poll(() => adRequests).toBe(2);
    const before = adRequests;
    expect(await page.evaluate(choice => window.__consentUI.writeConsent(choice), choice)).toBe(true);
    await expectAds(0);
    expect(adRequests).toBe(before);
    expect(await page.getByRole('dialog').count()).toBe(choice === null ? 1 : 0);
    expect(await page.evaluate(() => window.__consentUI.readConsent()?.ads === true)).toBe(false);
  });

  it('observes a real other-tab acceptance without refreshing either mounted gate', async () => {
    await render(); await expectAds(0);
    const other = await context.newPage(); await other.goto('https://consent-ui.invalid/');
    await other.addScriptTag({ content: bundle });
    await other.evaluate(() => window.__consentUI.render());
    await other.getByRole('button', { name: 'Accept all' }).click();
    await expectAds(2);
    expect(await page.getByRole('dialog').count()).toBe(0);
  });

  it.each(['remove', 'clear', 'deny', 'malformed'])('revokes on a real cross-tab storage %s and can accept a later valid choice', async change => {
    await storeRaw(JSON.stringify(granted)); await render(); await expectAds(2);
    const other = await context.newPage(); await other.goto('https://consent-ui.invalid/');
    await other.evaluate(({ key, change, denied }) => {
      if (change === 'clear') localStorage.clear();
      else if (change === 'remove') localStorage.removeItem(key);
      else localStorage.setItem(key, change === 'deny' ? JSON.stringify(denied) : '{"ads":true}');
    }, { key: storageKey, change, denied });
    await expectAds(0);
    expect(await page.getByRole('dialog').count()).toBe(change === 'deny' ? 0 : 1);
    await storeRaw(JSON.stringify(granted), other);
    await expectAds(2);
  });

  it.each([
    '{broken', 'null', '[]', 'true', '{"ads":true}',
    JSON.stringify({ ...granted, ads: 'true' }),
    JSON.stringify({ ...granted, necessary: false }),
    JSON.stringify({ ...granted, analytics: 1 }),
    JSON.stringify({ ...granted, decidedAt: 'not-a-date' }),
  ])('fails closed for malformed saved data: %s', async raw => {
    await storeRaw(raw); await render(); await expectAds(0);
    expect(await page.evaluate(() => window.__consentUI.readConsent())).toBeNull();
    expect(await page.getByRole('dialog').count()).toBe(1);
    expect(adRequests).toBe(0);
  });

  it.each(['getter', 'getItem', 'setItem'])('keeps ads off and reports blocked storage (%s)', async failure => {
    await page.evaluate(failure => {
      const fail = () => { throw new DOMException('Synthetic storage denial', 'SecurityError'); };
      if (failure === 'getter') Object.defineProperty(window, 'localStorage', { configurable: true, get: fail });
      else Storage.prototype[failure as 'getItem' | 'setItem'] = fail;
    }, failure);
    await render();
    await page.getByRole('button', { name: 'Accept all' }).click();
    await expectAds(0);
    expect(await page.getByRole('status').textContent()).toContain('could not be saved');
    expect(await page.getByRole('dialog').count()).toBe(1);
    expect(await page.evaluate(() => window.__consentUI.readConsent())).toBeNull();
    expect(adRequests).toBe(0);
  });

  it.each(['removeItem', 'setItem'] as const)('never resurrects an old grant after a failed revocation via %s', async method => {
    await storeRaw(JSON.stringify(granted)); await render(); await expectAds(2);
    const persisted = await page.evaluate(({ method, denied }) => {
      const original = Object.getOwnPropertyDescriptor(Storage.prototype, method)!;
      Storage.prototype[method] = () => { throw new DOMException('Synthetic storage denial', 'SecurityError'); };
      const result = window.__consentUI.writeConsent(method === 'removeItem' ? null : denied);
      Object.defineProperty(Storage.prototype, method, original);
      return result;
    }, { method, denied });
    expect(persisted).toBe(false);
    await expectAds(0);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).ads, storageKey)).toBe(true);
    await page.evaluate(key => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage, newValue: localStorage.getItem(key) }));
      window.__consentUI.unmount(); window.__consentUI.render();
    }, storageKey);
    await expectAds(0);
    expect(await page.evaluate(() => window.__consentUI.readConsent())).toBeNull();
    expect(await page.evaluate(() => window.__consentUI.writeConsent(null))).toBe(true);
    await page.getByRole('button', { name: 'Accept all' }).click();
    await expectAds(2);
  });

  it('ignores unrelated/session storage and forged grant payloads, and unsubscribes cleanly', async () => {
    await render();
    const seen = await page.evaluate(({ key, granted }) => {
      const fixture = window.__consentUI;
      const unsubscribe = fixture.subscribeConsent(() => fixture.notifications.push(fixture.readConsent()));
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', storageArea: localStorage }));
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: sessionStorage, newValue: JSON.stringify(granted) }));
      const ignored = fixture.notifications.length;
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: localStorage, newValue: JSON.stringify(granted) }));
      const forged = fixture.notifications.at(-1);
      fixture.writeConsent(granted);
      const accepted = fixture.notifications.at(-1);
      fixture.writeConsent(null);
      const revoked = fixture.notifications.at(-1);
      const before = fixture.notifications.length;
      unsubscribe(); fixture.writeConsent(null);
      return { ignored, forged, accepted, revoked, before, after: fixture.notifications.length };
    }, { key: storageKey, granted });
    expect(seen).toMatchObject({ ignored: 0, forged: null, accepted: granted, revoked: null });
    expect(seen.after).toBe(seen.before);
    await expectAds(0);
  });

  it.each(['focus', 'pageshow'])('rechecks site-data changes on %s without a storage event', async event => {
    await storeRaw(JSON.stringify(granted)); await render(); await expectAds(2);
    await page.evaluate(event => { localStorage.clear(); window.dispatchEvent(new Event(event)); }, event);
    await expectAds(0);
    expect(await page.getByRole('dialog').count()).toBe(1);
  });

  it.each([null, JSON.stringify(granted), JSON.stringify(denied), '{"ads":true}'])('keeps SSR/hydration deterministic with saved choice %s', async raw => {
    expect(typeof window).toBe('undefined');
    expect(legacyReadConsent).toBe(readConsent);
    expect(readConsent()).toBeNull();
    expect(writeConsent(granted)).toBe(false);
    expect(() => subscribeConsent(() => {})()).not.toThrow();
    const markup = renderToString(createElement(Fragment, null,
      createElement(ConsentBanner), ...[1, 2].map(id => createElement(ConsentGate, null,
        createElement(AdsterraBanner, { adsterraKey: `fixture-${id}`, width: 728, height: 90, mobileWidth: 320, mobileHeight: 50 }),
      )),
    ));
    expect(markup).toBe('');
    await storeRaw(raw);
    await page.locator('#root').evaluate((node, html) => { node.innerHTML = html; }, markup);
    await page.evaluate(() => window.__consentUI.render('consent', true));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectAds(raw === JSON.stringify(granted) ? 2 : 0);
    expect(await page.getByRole('dialog').count()).toBe(raw === null || raw === '{"ads":true}' ? 1 : 0);
    expect(await page.evaluate(() => window.__consentUI.errors)).toEqual([]);
  });
});

describe('footer destinations', () => {
  it.each([375, 1280])('links to existing pages without account/request prefetch at %ipx', async width => {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(() => window.__consentUI.render('footer'));
    expect(await page.getByRole('link', { name: 'Request a title', exact: true }).getAttribute('href')).toBe('/request');
    const party = page.getByRole('link', { name: 'Find a title for Watch Party', exact: true });
    expect(await party.getAttribute('href')).toBe('/browse');
    const helpId = await party.getAttribute('aria-describedby');
    expect(helpId).toBeTruthy();
    expect(await page.locator(`[id="${helpId}"]`).textContent()).toContain('where available');
    const accountLinks = page.getByRole('navigation', { name: 'Account', exact: true }).getByRole('link');
    expect(await accountLinks.evaluateAll(links => links.map(link => ({
      href: link.getAttribute('href'), prefetch: link.getAttribute('data-prefetch'),
      tabIndex: (link as HTMLAnchorElement).tabIndex,
    })))).toEqual(['/account', '/account/watchlist', '/browse', '/request', '/account/settings'].map(href => ({
      href, prefetch: 'false', tabIndex: 0,
    })));
    const focusableLinks = await accountLinks.all();
    await focusableLinks[0]!.focus();
    for (const [index, link] of focusableLinks.entries()) {
      if (index) await page.keyboard.press('Tab');
      expect(await link.evaluate(link => link === document.activeElement)).toBe(true);
    }
    const hrefs = await page.locator('footer a').evaluateAll(links => links.map(link => link.getAttribute('href')));
    expect(hrefs).not.toContain('/party'); expect(hrefs).not.toContain('/account/requests');
    for (const href of hrefs) {
      expect(href).toMatch(/^\/(?:[a-z/]+)?$/);
      expect(existsSync(join(project, 'src/app', href!.slice(1), 'page.tsx')), `Existing page for ${href}`).toBe(true);
    }
  });
});
