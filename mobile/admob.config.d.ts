export interface AdMobConfiguration { appId: string; iosAppId: string; bannerId: string; interstitialId: string; testAds: boolean; enabled: boolean }
export const TEST_IDS: Readonly<Omit<AdMobConfiguration, 'testAds' | 'enabled'>>;
export function resolveAdMobConfig(input?: {
  appId?: string; iosAppId?: string; bannerId?: string; interstitialId?: string; testAds?: string; development?: boolean;
}): AdMobConfiguration;
