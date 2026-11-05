/** Avoid invoking Android PiP APIs on releases older than API 26. */
export function canQueryPictureInPicture(os: string, version: string | number): boolean {
  if (os === 'ios') return true;
  if (os !== 'android') return false;
  const apiLevel = typeof version === 'number' ? version : Number.parseInt(version, 10);
  return Number.isFinite(apiLevel) && apiLevel >= 26;
}

/** expo-video source events may contain a URI string or a VideoSourceObject. */
export function nativeSourceUrl(source: unknown): string | null {
  if (typeof source === 'string' && source) return source;
  if (source && typeof source === 'object' && 'uri' in source && typeof source.uri === 'string' && source.uri) return source.uri;
  return null;
}

export const SOURCE_READY_TIMEOUT_MS = 20_000;
