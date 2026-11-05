import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSupabaseRuntimeConfig, resolveWebRuntimeConfig } from '../../mobile/src/lib/runtime-config';
import { canQueryPictureInPicture } from '../../mobile/src/player/capabilities';
import { renditionUrl } from '../../mobile/src/player/options';
import { TEST_IDS, resolveAdMobConfig } from '../../mobile/admob.config';

const require = createRequire(import.meta.url);

describe('mobile startup fail-closed configuration', () => {
  it('constructs inert Supabase values instead of throwing when public settings are absent or malformed', () => {
    expect(resolveSupabaseRuntimeConfig(undefined, undefined)).toMatchObject({ configured: false,
      url: 'https://unconfigured.invalid' });
    expect(resolveSupabaseRuntimeConfig('javascript:alert(1)', 'public')).toMatchObject({ configured: false });
    expect(resolveSupabaseRuntimeConfig('https://project.supabase.co', 'public-anon-key')).toEqual({
      configured: true, url: 'https://project.supabase.co', anonKey: 'public-anon-key',
    });
  });

  it('uses the public default only when the web setting is absent and disables malformed explicit URLs', () => {
    expect(resolveWebRuntimeConfig(undefined)).toMatchObject({ available: true, source: 'default' });
    expect(resolveWebRuntimeConfig('https://catalog.example/')).toEqual({
      url: 'https://catalog.example', available: true, source: 'environment',
    });
    expect(resolveWebRuntimeConfig('https://user:password@catalog.example')).toMatchObject({ available: false, source: 'invalid' });
  });

  it('keeps malformed production ads disabled while supplying both native app IDs', () => {
    expect(resolveAdMobConfig({ testAds: 'false' })).toEqual({ ...TEST_IDS, testAds: true, enabled: false });
    const appConfig = require('../../mobile/app.config.js');
    const result = appConfig({ config: { plugins: [] } });
    expect(result.plugins[0][1]).toMatchObject({ androidAppId: TEST_IDS.appId, iosAppId: TEST_IDS.iosAppId,
      delayAppMeasurementInit: true });
  });

  it('gates Android PiP below API 26 and tolerates malformed optional rendition URLs', () => {
    expect(canQueryPictureInPicture('android', 25)).toBe(false);
    expect(canQueryPictureInPicture('android', '26')).toBe(true);
    expect(canQueryPictureInPicture('ios', '18.0')).toBe(true);
    expect(canQueryPictureInPicture('web', 99)).toBe(false);
    expect(renditionUrl('not a URL')).toBe('not a URL');
  });

  it('mounts a top-level recovery boundary and uses the supported splash plugin schema', () => {
    const appSource = readFileSync(new URL('../../mobile/App.tsx', import.meta.url), 'utf8');
    expect(appSource).toContain('<AppErrorBoundary><AdMobProvider><AppNavigation /></AdMobProvider></AppErrorBoundary>');
    const appJson = JSON.parse(readFileSync(new URL('../../mobile/app.json', import.meta.url), 'utf8')).expo;
    expect(appJson).not.toHaveProperty('splash');
    expect(appJson.plugins).toContainEqual(['expo-splash-screen', expect.objectContaining({ image: './assets/splash-icon.png' })]);
  });
});
