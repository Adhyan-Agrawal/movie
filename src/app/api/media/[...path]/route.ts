import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { features } from '@/lib/env';

/**
 * HLS media proxy (Spec Section 9 — native playback).
 *
 * Transcode output lives in the PRIVATE `media` bucket: nothing there is ever
 * publicly readable. A plain signed URL works for the master playlist but NOT
 * for the child playlists/segments — hls.js resolves those relative to the
 * master URL, which drops the signature and would 401. This route streams any
 * object under the `media` bucket server-side (service role), so an HLS tree
 * resolves correctly: `/api/media/hls/{slug}/index.m3u8` → relative
 * `1080/index.m3u8` → `/api/media/hls/{slug}/1080/index.m3u8`, each served from
 * the private bucket without ever making it public.
 *
 * SECURITY:
 *  - Path is constrained to the `media` bucket root with no `..` / absolute
 *    traversal; a malformed path returns 400/404.
 *  - Only this route (service role) reads the bucket — direct object URLs stay
 *    blocked, so "the world can never access it directly" remains true.
 *  - Responses are immutable-ish (short max-age) and content-type-set from the
 *    extension; no auth token or secret is ever exposed.
 */

const CONTENT_TYPES: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  mp4: 'video/mp4',
  m4s: 'video/iso.segment',
  vtt: 'text/vtt',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  json: 'application/json',
};

export const runtime = 'nodejs';

function contentTypeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!features.supabaseConfigured) {
    return new NextResponse('Media not configured', { status: 503 });
  }
  const { path } = await params;
  if (!path || path.length === 0) return new NextResponse('Not found', { status: 404 });

  const storagePath = path.join('/');
  // Hard constraint: the resolved path must stay inside the bucket root.
  const segments = path.map(decodeURIComponent);
  if (segments.some((s) => !s || s === '..' || s.includes('/') || s.includes('\\'))) {
    return new NextResponse('Bad path', { status: 400 });
  }

  try {
    const service = getSupabaseServiceClient();
    const { data, error } = await service.storage.from('media').download(storagePath);
    if (error) {
      // Missing object → 404, not a server error (hls.js just stops trying).
      return new NextResponse('Not found', { status: error.message.includes('not found') ? 404 : 502 });
    }
    const body = await data.arrayBuffer();

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(storagePath),
        'Cache-Control': 'public, max-age=300, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    console.warn('media.proxy failed', {
      path: storagePath,
      message: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse('Media unavailable', { status: 502 });
  }
}
