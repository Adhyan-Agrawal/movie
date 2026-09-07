// Decisive vsembed test: get signed player URL from vs_src.php, then IMMEDIATELY
// fetch the cloudorchestranova.com player page and check markers.
// Never logs the signed token or any stream/manifest URL.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function checkVsembed(id) {
  const api = `https://vsembed.su/vs_src.php?type=tv&id=${encodeURIComponent(id)}&season=1&episode=1`;
  const r1 = await fetch(api, { headers: { 'user-agent': UA, referer: 'https://vsembed.su/embed/tv/1416/1/1' } });
  const body1 = await r1.text();
  let playerUrl = null;
  try {
    const j = JSON.parse(body1);
    if (typeof j.src === 'string' && j.src.startsWith('http')) playerUrl = j.src;
  } catch {}

  let markers = { status: -1, videoJs: false, hlsJs: false, m3u8Ref: false, errorText: null, playerTitle: null };
  if (playerUrl) {
    const r2 = await fetch(playerUrl, { headers: { 'user-agent': UA, referer: `https://vsembed.su/embed/tv/${id}/1/1` } });
    const body2 = await r2.text();
    markers.status = r2.status;
    markers.videoJs = /video\.js|vjs|jwplayer/i.test(body2);
    markers.hlsJs = /hls\.js|clappr|shaka/i.test(body2);
    markers.m3u8Ref = /\.m3u8|master\.|playlist/i.test(body2);
    const m = body2.match(/<title>([^<]{0,60})<\/title>/i);
    markers.playerTitle = m ? m[1] : null;
    const err = body2.match(/(not found|invalid|expired|error|no (video|title|result)|unavailable)[^<]{0,40}/i);
    if (err && !/(\.js|hls)/i.test(err[0])) markers.errorText = err[0].slice(0, 60);
  }
  console.log(`\n=== vsembed id=${id} ===`);
  console.log(`  vs_src.php status=${r1.status} -> playerUrl=${playerUrl ? 'yes(redacted)' : 'no'}`);
  console.log(`  player status=${markers.status} title=${markers.playerTitle} videoJs=${markers.videoJs} hlsJs=${markers.hlsJs} m3u8Ref=${markers.m3u8Ref} errText=${markers.errorText}`);
  return { id, ...markers };
}

const tmdb = await checkVsembed('1416');
const imdb = await checkVsembed('tt0413573');
console.log('\n########## vsembed verdict ##########');
const verdict = (m) => (m.m3u8Ref || m.videoJs || m.hlsJs) && m.status === 200 && !m.errorText ? 'PLAYER_OK' : m.errorText ? 'ERROR' : 'UNKNOWN';
console.log(`TMDB : ${verdict(tmdb)} (${JSON.stringify(tmdb)})`);
console.log(`IMDb : ${verdict(imdb)} (${JSON.stringify(imdb)})`);
