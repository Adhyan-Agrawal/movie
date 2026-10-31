const TEST_IDS = Object.freeze({
  appId: 'ca-app-pub-3940256099942544~3347511713',
  bannerId: 'ca-app-pub-3940256099942544/9214589741',
  interstitialId: 'ca-app-pub-3940256099942544/1033173712',
});

function resolveAdMobConfig({ appId, bannerId, interstitialId, testAds, development = false } = {}) {
  const ids = { appId, bannerId, interstitialId };
  for (const [name, value] of Object.entries(ids)) {
    const pattern = name === 'appId' ? /^ca-app-pub-\d{16}~\d{10}$/ : /^ca-app-pub-\d{16}\/\d{10}$/;
    if (value !== undefined && value !== '' && (typeof value !== 'string' || !pattern.test(value))) {
      throw new Error(`Invalid public AdMob ${name}; use a Google app/unit ID, never a credential.`);
    }
  }
  if (testAds !== undefined && testAds !== '' && testAds !== 'true' && testAds !== 'false') {
    throw new Error('EXPO_PUBLIC_ADMOB_TEST_ADS must be true or false.');
  }
  const useTests = development || testAds !== 'false';
  if (!useTests && Object.values(ids).some((value) => !value)) {
    throw new Error('Production AdMob mode requires all three public app/banner/interstitial IDs.');
  }
  return { ...(useTests ? TEST_IDS : ids), testAds: useTests };
}

module.exports = { TEST_IDS, resolveAdMobConfig };
