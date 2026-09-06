/**
 * Pure media-source helpers shared by the admin upload/source actions and the
 * SourcesManager UI (and unit-tested in tests/unit/source-utils.test.ts).
 *
 * This module is intentionally dependency-free and safe to import from both
 * server and client bundles — 'use server' files may only export async
 * functions, so every pure helper used by those actions lives here instead.
 */

/**
 * Infer a `media_source_kind` from a filename or URL by looking at its
 * extension. Extensions are matched case-insensitively; query strings and
 * fragments are ignored so raw stream URLs ("master.m3u8?token=…") infer
 * correctly. Unknown/missing extensions return 'custom'.
 */
export function inferSourceKind(input: string): 'mp4' | 'hls' | 'dash' | 'custom' {
  // Strip any query/fragment, then take the final path segment as the name.
  const name = input.split(/[?#]/, 1)[0] ?? '';
  const base = name.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'custom'; // no/leading-only extension
  const ext = base.slice(dot + 1).toLowerCase();

  switch (ext) {
    case 'm3u8':
    case 'm3u':
      return 'hls';
    case 'mp4':
    case 'm4v':
      return 'mp4';
    case 'mpd':
      return 'dash';
    default:
      return 'custom';
  }
}

/**
 * Kind used when adding a REMOTE source: same extension inference as
 * {@link inferSourceKind}, but unknown URLs default to 'hls' — most licensed
 * streams are HLS and manifest URLs frequently have no extension at all.
 */
export function inferRemoteSourceKind(url: string): 'mp4' | 'hls' | 'dash' {
  const inferred = inferSourceKind(url);
  return inferred === 'custom' ? 'hls' : inferred;
}

/**
 * Sanitize a user-supplied filename for the private `media` bucket: drop any
 * path components (directory traversal, Windows separators), replace every
 * character outside [A-Za-z0-9.-] with a dash, collapse runs of dashes, trim
 * leading/trailing dots and dashes, and cap the length. Returns '' for names
 * with nothing usable left.
 */
export function sanitizeUploadFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 120);
  return cleaned;
}
