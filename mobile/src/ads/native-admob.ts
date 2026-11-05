export type NativeAdMobSdk = typeof import('react-native-google-mobile-ads');

declare const require: (id: string) => unknown;

let loaded: NativeAdMobSdk | null | undefined;

/** A missing or mismatched optional native module disables ads instead of aborting JS startup. */
export function getNativeAdMobSdk(): NativeAdMobSdk | null {
  if (loaded !== undefined) return loaded;
  try {
    const sdk = require('react-native-google-mobile-ads') as Partial<NativeAdMobSdk>;
    loaded = typeof sdk.default === 'function'
      && typeof sdk.InterstitialAd?.createForAdRequest === 'function'
      && typeof sdk.AdsConsent?.requestInfoUpdate === 'function'
      ? sdk as NativeAdMobSdk
      : null;
  } catch {
    loaded = null;
  }
  return loaded;
}
