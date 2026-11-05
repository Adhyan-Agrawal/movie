const TEST_IDS = Object.freeze({
  appId: 'ca-app-pub-3940256099942544~3347511713',
  iosAppId: 'ca-app-pub-3940256099942544~1458002511',
  bannerId: 'ca-app-pub-3940256099942544/9214589741',
  interstitialId: 'ca-app-pub-3940256099942544/1033173712',
});

function resolveAdMobConfig({ appId, iosAppId, bannerId, interstitialId, testAds, development = false } = {}) {
  const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const ids = { appId: clean(appId), iosAppId: clean(iosAppId), bannerId: clean(bannerId), interstitialId: clean(interstitialId) };
  let valid = testAds === undefined || testAds === '' || testAds === 'true' || testAds === 'false';
  for (const [name, value] of Object.entries(ids)) {
    const pattern = name === 'appId' || name === 'iosAppId' ? /^ca-app-pub-\d{16}~\d{10}$/ : /^ca-app-pub-\d{16}\/\d{10}$/;
    if (value !== undefined && !pattern.test(value)) valid = false;
  }
  const useTests = development || testAds !== 'false';
  const completeProduction = !!ids.appId && !!ids.bannerId && !!ids.interstitialId;
  if (!useTests && !completeProduction) valid = false;
  if (useTests || !valid) return { ...TEST_IDS, testAds: true, enabled: valid };
  return { ...ids, iosAppId: ids.iosAppId ?? TEST_IDS.iosAppId, testAds: false, enabled: true };
}

module.exports = { TEST_IDS, resolveAdMobConfig };
