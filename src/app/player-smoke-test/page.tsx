import { PlayerShell } from '@/features/player/PlayerShell';
import type { PlaybackSource } from '@/lib/providers/types';

const capabilities = {
  fullscreen: true, qualitySelection: true, audioTracks: true, subtitles: true,
  playbackRate: true, episodeSelection: false, providerResume: false, telemetry: true, skipMarkers: false,
};
const sources: PlaybackSource[] = [
  {
    id: 'direct', label: 'Direct', kind: 'hls',
    url: '/api/vidnest?tmdbId=27205&type=movie&stream=auto',
    streamCatalogUrl: '/api/vidnest?tmdbId=27205&type=movie&metadata=1',
    consentRequired: true, capabilities,
  },
  { id: 'embed', label: 'Server 1', kind: 'iframe', url: '/offline', consentRequired: true, capabilities },
];

export default function PlayerSmokeTest() {
  return <main className="mx-auto max-w-5xl p-4"><PlayerShell
    title={{ id: '00000000-0000-4000-8000-000000000000', name: 'Player Lab', slug: 'player-smoke-test', type: 'movie' }}
    source={sources[0]!}
    sources={sources}
    viewerKey="guest"
    preroll={{ adsterraKey: 'smoke-test', width: 300, height: 250 }}
  /></main>;
}
