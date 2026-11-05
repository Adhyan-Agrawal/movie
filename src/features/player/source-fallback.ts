import type { PlaybackSource } from '@/lib/providers/types';

const NATIVE_KINDS = new Set<PlaybackSource['kind']>(['mp4', 'hls', 'dash']);

export function selectPlaybackFallback(
  sources: PlaybackSource[],
  currentId: string | null,
  failedIds: ReadonlySet<string>,
): PlaybackSource | null {
  const candidates = sources.filter((source) => Boolean(source.url) && source.id !== currentId && !failedIds.has(source.id));
  return candidates.find((source) => !NATIVE_KINDS.has(source.kind)) ?? candidates[0] ?? null;
}
