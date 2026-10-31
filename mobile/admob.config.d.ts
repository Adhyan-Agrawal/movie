export interface AdMobConfiguration { appId: string; bannerId: string; interstitialId: string; testAds: boolean }
export const TEST_IDS: Readonly<Omit<AdMobConfiguration, 'testAds'>>;
export function resolveAdMobConfig(input?: {
  appId?: string; bannerId?: string; interstitialId?: string; testAds?: string; development?: boolean;
}): AdMobConfiguration;
