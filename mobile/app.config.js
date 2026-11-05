const { resolveAdMobConfig } = require('./admob.config');

module.exports = ({ config }) => {
  const ads = resolveAdMobConfig({
    appId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID,
    iosAppId: process.env.EXPO_PUBLIC_ADMOB_IOS_APP_ID,
    bannerId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID,
    interstitialId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_INTERSTITIAL_ID,
    testAds: process.env.EXPO_PUBLIC_ADMOB_TEST_ADS,
  });
  const configuredWebUrl = process.env.EXPO_PUBLIC_WEB_URL?.trim() || 'https://hulkofyt.eu.org';
  let appLinkHost = null;
  try {
    const webUrl = new URL(configuredWebUrl);
    if (webUrl.protocol === 'https:' && !webUrl.username && !webUrl.password && webUrl.pathname === '/' && !webUrl.search && !webUrl.hash) {
      appLinkHost = webUrl.hostname;
    }
  } catch { /* Invalid explicit URLs are rejected by the runtime config. */ }
  const android = { ...(config.android || {}), ...(appLinkHost ? { intentFilters: [
    ...((config.android && config.android.intentFilters) || []),
    { action: 'VIEW', autoVerify: true, data: [{ scheme: 'https', host: appLinkHost, pathPrefix: '/watch' }],
      category: ['BROWSABLE', 'DEFAULT'] },
  ] } : {}) };
  return { ...config, android, plugins: [
    ...(config.plugins ?? []),
    ['react-native-google-mobile-ads', { androidAppId: ads.appId, iosAppId: ads.iosAppId,
      androidSdk: 'nextgen', delayAppMeasurementInit: true }],
  ] };
};
