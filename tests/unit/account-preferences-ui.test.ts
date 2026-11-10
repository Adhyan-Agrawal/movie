import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createElement, type AnchorHTMLAttributes } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountPreferencesResult } from '@/features/account/preference-types';
import { DEFAULT_SETTINGS } from '@/features/account/types';
import { settingsStorageKey } from '@/features/account/settings-store';

vi.mock('next/link', () => ({ default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => createElement('a', props) }));
vi.mock('@/features/account/preference-actions', () => ({ loadAccountPreferencesAction: vi.fn(), saveAccountPreferencesAction: vi.fn() }));
import { SettingsForm, type SettingsFormProps } from '@/features/account/SettingsForm';

const project = fileURLToPath(new URL('../../', import.meta.url));
const accountA = '10000000-0000-4000-8000-000000000001';
const accountB = '20000000-0000-4000-8000-000000000002';
const snapshot = (accountId = accountA, autoplayNext = false, hasSavedPreferences = true) => ({
  accountId, settings: { ...DEFAULT_SETTINGS, autoplayNext }, hasSavedPreferences,
});
const entry = `
  import {StrictMode} from 'react';
  import {createRoot,hydrateRoot} from 'react-dom/client';
  import {flushSync} from 'react-dom';
  import {SettingsForm} from '@/features/account/SettingsForm';
  import {DEFAULT_SETTINGS} from '@/features/account/types';
  import {ViewingPreferencesProvider,useViewingPreferences} from '@/features/account/ViewingPreferencesProvider';
  import {writeAccountSettings,ACCOUNT_SETTINGS_EVENT} from '@/features/account/settings-store';
  const fixture = window.__preferencesUI = {calls:[],reads:[],errors:[],holdReads:false,holdSaves:false,
    pendingReads:[],pendingSaves:[],saveResult:null,loadResult:null};
  fixture.load = async owner => {
    fixture.reads.push(owner);
    return fixture.holdReads ? new Promise(resolve=>fixture.pendingReads.push(resolve)) : fixture.loadResult;
  };
  fixture.save = async (owner,patch) => {
    fixture.calls.push({owner,patch});
    if(fixture.holdSaves) return new Promise(resolve=>fixture.pendingSaves.push(resolve));
    if(fixture.saveResult==='throw') throw new Error('synthetic private failure');
    return fixture.saveResult ?? {ok:true,snapshot:{accountId:owner,settings:{...DEFAULT_SETTINGS,...patch},hasSavedPreferences:true}};
  };
  const options={onRecoverableError:error=>fixture.errors.push(error.message),onUncaughtError:error=>fixture.errors.push(error.message)};
  let root;
  fixture.render=(props,hydrate=false,strict=false)=>{
    const element=strict?<StrictMode><SettingsForm {...props}/></StrictMode>:<SettingsForm {...props}/>;
    if(hydrate){root=hydrateRoot(document.getElementById('root'),element,options);return}
    root??=createRoot(document.getElementById('root'),options);
    flushSync(()=>root.render(element));
  };
  fixture.unmount=()=>{flushSync(()=>root?.unmount());root=undefined};
  function ViewingState(){const value=useViewingPreferences();return <output id="viewing-state">{JSON.stringify(value)}</output>}
  fixture.renderViewing=(props)=>{root??=createRoot(document.getElementById('root'),options);flushSync(()=>root.render(<ViewingPreferencesProvider {...props}><ViewingState/></ViewingPreferencesProvider>))};
  fixture.acknowledge=(owner,settings)=>writeAccountSettings(owner,settings);
  fixture.notify=()=>window.dispatchEvent(new Event(ACCOUNT_SETTINGS_EVENT));
`;

declare global {
  interface Window {
    __preferencesUI: {
      calls: Array<{ owner: string; patch: unknown }>;
      reads: string[]; errors: string[];
      holdReads: boolean; holdSaves: boolean;
      loadResult: AccountPreferencesResult;
      saveResult: AccountPreferencesResult | 'throw' | null;
      pendingReads: Array<(value: AccountPreferencesResult) => void>;
      pendingSaves: Array<(value: AccountPreferencesResult) => void>;
      render: (props: SettingsFormProps, hydrate?: boolean, strict?: boolean) => void;
      unmount: () => void;
      renderViewing: (props: { mode: 'guest' | 'account' | 'unavailable'; initialPreferences: ReturnType<typeof snapshot> | null }) => void;
      acknowledge: (owner: string, settings: typeof DEFAULT_SETTINGS) => boolean;
      notify: () => void;
    };
  }
}

let browser: Browser;
let context: BrowserContext;
let page: Page;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    absWorkingDir: project, stdin: { contents: entry, loader: 'tsx', resolveDir: project },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'preference-ui-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === 'next/link') return { path: 'link', namespace: 'fixture' };
        if (args.path.endsWith('/preference-actions')) return { path: 'actions', namespace: 'fixture' };
        if (/^(next\/|server-only|@supabase\/)/.test(args.path)) throw new Error(`Unexpected backend: ${args.path}`);
      });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ loader: 'tsx', resolveDir: project,
        contents: args.path === 'link' ? 'export default function Link(props){return <a {...props}/>}'
          : 'export const loadAccountPreferencesAction=(owner)=>window.__preferencesUI.load(owner); export const saveAccountPreferencesAction=(owner,patch)=>window.__preferencesUI.save(owner,patch);',
      }));
    } }],
  });
  bundle = result.outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
}, 30_000);

beforeEach(async () => {
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.route('**/*', (route) => route.request().url() === 'https://preferences.invalid/'
    ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><body><div id="root"></div></body></html>' })
    : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(3000);
  await page.goto('https://preferences.invalid/'); await page.addScriptTag({ content: bundle });
  await page.evaluate((value) => { window.__preferencesUI.loadResult = value; }, { ok: true as const, snapshot: snapshot() });
});
afterEach(async () => {
  try { expect(await page.evaluate(() => window.__preferencesUI.errors)).toEqual([]); }
  finally { await context?.close(); }
});
afterAll(async () => { await browser?.close(); });

async function render(props: SettingsFormProps = { accountId: accountA }) {
  await page.evaluate((value) => window.__preferencesUI.render(value), props);
}
const toggle = () => page.getByRole('switch', { name: 'Autoplay next episode', exact: true });
const save = () => page.getByRole('button', { name: 'Save preferences', exact: true });
async function ready() { await expect.poll(() => save().isEnabled()).toBe(true); }

describe('mounted account preference form', () => {
  it('applies acknowledged browsing preferences without trusting a forged notification', async () => {
    const initial = snapshot();
    await page.evaluate((value) => window.__preferencesUI.renderViewing({ mode: 'account', initialPreferences: value }), initial);
    const before = await page.locator('#viewing-state').textContent();
    await page.evaluate(() => window.__preferencesUI.notify());
    expect(await page.locator('#viewing-state').textContent()).toBe(before);
    await page.evaluate(({ owner, settings }) => window.__preferencesUI.acknowledge(owner, settings), {
      owner: accountA, settings: { ...DEFAULT_SETTINGS, autoplayPreviews: false, reducedMotion: true },
    });
    await expect.poll(() => page.locator('#viewing-state').textContent()).toBe('{"autoplayPreviews":false,"reducedMotion":true}');
    expect(await page.locator('[data-viewing-motion="reduce"]').count()).toBe(1);
  });

  it('keeps confirmed preferences active when local caching fails and fences another account', async () => {
    await page.evaluate((value) => window.__preferencesUI.renderViewing({ mode: 'account', initialPreferences: value }), snapshot());
    const persisted = await page.evaluate(({ owner, settings }) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = () => { throw new Error('synthetic storage denial'); };
      try { return window.__preferencesUI.acknowledge(owner, settings); } finally { Storage.prototype.setItem = original; }
    }, { owner: accountA, settings: { ...DEFAULT_SETTINGS, reducedMotion: true } });
    expect(persisted).toBe(false);
    await expect.poll(() => page.locator('[data-viewing-motion="reduce"]').count()).toBe(1);
    await page.evaluate((value) => window.__preferencesUI.renderViewing({ mode: 'account', initialPreferences: value }), snapshot(accountB));
    expect(await page.locator('[data-viewing-motion="reduce"]').count()).toBe(0);
    await page.evaluate(() => window.__preferencesUI.notify());
    expect(await page.locator('[data-viewing-motion="reduce"]').count()).toBe(0);
  });

  it('retains guest previews and blocks automatic previews for unavailable identity', async () => {
    await page.evaluate(() => window.__preferencesUI.renderViewing({ mode: 'guest', initialPreferences: null }));
    expect(await page.locator('#viewing-state').textContent()).toBe('{"autoplayPreviews":true,"reducedMotion":false}');
    await page.evaluate(() => window.__preferencesUI.renderViewing({ mode: 'unavailable', initialPreferences: null }));
    expect(await page.locator('#viewing-state').textContent()).toBe('{"autoplayPreviews":false,"reducedMotion":false}');
  });

  it('loads verified choices, saves explicitly, and caches only confirmed non-security preferences', async () => {
    await render(); await ready(); expect(await toggle().getAttribute('aria-checked')).toBe('false');
    await toggle().click(); await save().click();
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account.');
    expect(await page.evaluate(() => window.__preferencesUI.calls)).toEqual([{ owner: accountA, patch: { ...DEFAULT_SETTINGS, autoplayNext: true } }]);
    const cached = await page.evaluate((key) => localStorage.getItem(key), settingsStorageKey(accountA));
    expect(JSON.parse(cached!)).toEqual({ ...DEFAULT_SETTINGS, autoplayNext: true });
    expect(await page.getByLabel('Default maturity level').count()).toBe(0);
  });

  it.each(['failed', 'thrown'])('retains the draft and never claims persistence after a %s save', async (failure) => {
    await render(); await ready(); await toggle().click();
    await page.evaluate((kind) => { window.__preferencesUI.saveResult = kind === 'thrown' ? 'throw' : { ok: false, reason: 'unavailable', message: 'Account preferences are unavailable.' }; }, failure);
    await save().click(); await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(await toggle().getAttribute('aria-checked')).toBe('true'); expect(await save().isEnabled()).toBe(true);
    expect(await page.evaluate((key) => localStorage.getItem(key), settingsStorageKey(accountA))).toBeNull();
    expect(await page.locator('body').textContent()).not.toContain('synthetic private failure');
    await page.evaluate(() => { window.__preferencesUI.saveResult = null; }); await save().click();
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account.');
  });

  it('coalesces duplicate submits while saving and waits for an acknowledgement', async () => {
    await render(); await ready(); await page.evaluate(() => { window.__preferencesUI.holdSaves = true; });
    await save().click(); await page.locator('form').dispatchEvent('submit');
    expect(await page.evaluate(() => window.__preferencesUI.calls.length)).toBe(1);
    expect(await page.getByRole('button', { name: 'Saving preferences...' }).isDisabled()).toBe(true);
    expect(await page.getByText('Saved to your account.', { exact: true }).count()).toBe(0);
    await page.evaluate((value) => window.__preferencesUI.pendingSaves[0]!(value), { ok: true as const, snapshot: snapshot() });
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account.');
  });

  it('preserves a save confirmation and a later draft across same-account server revalidation', async () => {
    await render({ accountId: accountA, initialPreferences: snapshot() }); await ready();
    await toggle().click(); await save().click();
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account.');
    await render({ accountId: accountA, initialPreferences: snapshot(accountA, true) });
    expect(await page.getByRole('status').textContent()).toBe('Saved to your account.');
    await toggle().click();
    await render({ accountId: accountA, initialPreferences: snapshot(accountA, true) });
    expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(await page.evaluate(() => window.__preferencesUI.calls.length)).toBe(1);
  });

  it.each(['unauthenticated', 'unverified', 'unavailable'] as const)('disables edits and offers a truthful load retry for %s', async (reason) => {
    await page.evaluate((status) => { window.__preferencesUI.loadResult = { ok: false, reason: status, message: 'Preferences cannot be loaded.' }; }, reason);
    await render(); await expect.poll(() => page.getByRole('alert').count()).toBe(1);
    expect(await save().isDisabled()).toBe(true); expect(await toggle().isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.__preferencesUI.calls)).toEqual([]);
    await page.evaluate((value) => { window.__preferencesUI.loadResult = value; }, { ok: true as const, snapshot: snapshot() });
    await page.getByRole('button', { name: 'Retry loading preferences' }).click(); await ready();
  });

  it('does not reuse a previous account draft or accept its delayed load', async () => {
    await page.evaluate(() => { window.__preferencesUI.holdReads = true; });
    await render(); await render({ accountId: accountB });
    await expect.poll(() => page.evaluate(() => window.__preferencesUI.pendingReads.length)).toBe(2);
    await page.evaluate((value) => window.__preferencesUI.pendingReads[0]!(value), { ok: true as const, snapshot: snapshot(accountA, true) });
    expect(await save().isDisabled()).toBe(true);
    await page.evaluate((value) => window.__preferencesUI.pendingReads[1]!(value), { ok: true as const, snapshot: snapshot(accountB, false) });
    await ready(); expect(await toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('ignores a save response after the account changes, without writing either cache', async () => {
    await render(); await ready(); await page.evaluate(() => { window.__preferencesUI.holdSaves = true; });
    await toggle().click(); await save().click();
    await render({ accountId: accountB, initialPreferences: snapshot(accountB, false) }); await ready();
    await page.evaluate((value) => window.__preferencesUI.pendingSaves[0]!(value), { ok: true as const, snapshot: snapshot(accountA, true) });
    expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(await page.getByText('Saved to your account.', { exact: true }).count()).toBe(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), settingsStorageKey(accountA))).toBeNull();
  });

  it('offers legacy same-account choices for explicit migration without touching guest Auto Next', async () => {
    await page.evaluate(({ key, owner }) => {
      localStorage.setItem(key, JSON.stringify({ autoplayNext: false, language: 'fr', maturity: 'kids' }));
      localStorage.setItem('lumora:player:auto-next:v1', 'true');
      window.__preferencesUI.loadResult = { ok: true, snapshot: owner };
    }, { key: settingsStorageKey(accountA), owner: snapshot(accountA, true, false) });
    await render(); await ready(); expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(await page.evaluate(() => window.__preferencesUI.calls)).toEqual([]);
    await save().click(); await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account.');
    expect(await page.evaluate(() => localStorage.getItem('lumora:player:auto-next:v1'))).toBe('true');
  });

  it('reports server success separately from a blocked browser cache', async () => {
    await render(); await ready();
    await page.evaluate(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } }));
    await save().click();
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Saved to your account. This browser could not keep a local cache.');
  });

  it.each([375, 1280])('hydrates a server preference without browser reads or identity mismatch at %ipx', async (width) => {
    await page.setViewportSize({ width, height: 900 });
    const props: SettingsFormProps = { accountId: accountA, initialPreferences: snapshot(accountA, false) };
    const html = renderToString(createElement(SettingsForm, props));
    await page.evaluate((markup) => { document.getElementById('root')!.innerHTML = markup; }, html);
    await page.evaluate((value) => window.__preferencesUI.render(value, true), props);
    await ready(); expect(await toggle().getAttribute('aria-checked')).toBe('false');
    expect(await page.evaluate(() => window.__preferencesUI.reads)).toEqual([]);
    await toggle().focus(); await page.keyboard.press('Space');
    expect(await toggle().getAttribute('aria-checked')).toBe('true');
  });
});
