const { resolveAdMobConfig } = require('./admob.config');

module.exports = ({ config }) => {
  const ads = resolveAdMobConfig({
    appId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_APP_ID,
    bannerId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_BANNER_ID,
    interstitialId: process.env.EXPO_PUBLIC_ADMOB_ANDROID_INTERSTITIAL_ID,
    testAds: process.env.EXPO_PUBLIC_ADMOB_TEST_ADS,
  });
  return { ...config, plugins: [
    ...(config.plugins ?? []),
    ['react-native-google-mobile-ads', { androidAppId: ads.appId, androidSdk: 'nextgen', delayAppMeasurementInit: true }],
  ] };
};
