import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { getSupabasePublicClient } from '@/lib/supabase/public';
import { features } from '@/lib/env';

/**
 * Public playback of the generated HLS ladder, NOT a private-bucket proxy.
 *
 * Only scripts/transcode-hls.mjs output attached to an enabled native source
 * and an anonymously readable, published title may cross this boundary.
 * Editor cookies never grant a public URL access to drafts or raw uploads.
 * The bucket itself remains private, with its storage RLS unchanged.
 */
const HLS_PATH = /^hls\/([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)(\/episodes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\/(master\.m3u8|(?:1080|720|480)\/(?:index\.m3u8|seg_[0-9]{4,8}\.ts))$/;
const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failure(message: string, status: number) {
  return new NextResponse(message, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!features.supabaseConfigured) {
    return failure('Media not configured', 503);
  }

  try {
    const { path } = await params;
    if (!Array.isArray(path) || !path.length) return failure('Not found', 404);
    // Next has decoded the segments already. Reject further encoding and URL
    // metacharacters instead of validating one spelling and downloading another.
    if (path.length > 6 || path.some((segment) => typeof segment !== 'string'
      || !/^[A-Za-z0-9._-]{1,200}$/.test(segment) || segment === '.' || segment === '..')) {
      return failure('Bad path', 400);
    }
    const storagePath = path.join('/');
    const match = HLS_PATH.exec(storagePath);
    if (!match) return failure('Not found', 404);
    const [, slug, episodeSuffix, episodeId] = match;
    const masterPath = `hls/${slug}${episodeSuffix ?? ''}/master.m3u8`;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
    signal.throwIfAborted();

    const db = getSupabasePublicClient();
    const { data: title, error: titleError } = await db.from('titles').select('id')
      .eq('slug', slug!).eq('status', 'published').eq('visibility', 'public')
      .or(`published_at.is.null,published_at.lte.${new Date().toISOString()}`)
      .abortSignal(signal).maybeSingle();
    if (titleError) throw new Error('Title lookup failed');
    if (!title) return failure('Not found', 404);
    if (episodeId) {
      const { data: episode, error: episodeError } = await db.from('episodes').select('id')
        .eq('id', episodeId).eq('title_id', title.id).abortSignal(signal).maybeSingle();
      if (episodeError) throw new Error('Episode lookup failed');
      if (!episode) return failure('Not found', 404);
    }

    // Raw source rows are provider-managed under RLS. Service access is limited
    // to this exact public title/episode's registered, enabled native ladder.
    const service = getSupabaseServiceClient();
    let sourceQuery = service.from('media_sources').select('id, geo_policy')
      .eq('title_id', title.id).eq('reference', masterPath).eq('kind', 'hls').eq('enabled', true)
      .is('url', null).is('provider_id', null);
    sourceQuery = episodeId ? sourceQuery.eq('episode_id', episodeId) : sourceQuery.is('episode_id', null);
    const { data: source, error: sourceError } = await sourceQuery.abortSignal(signal).maybeSingle();
    if (sourceError) throw new Error('Source lookup failed');
    if (!source) return failure('Not found', 404);
    const policy = source.geo_policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || policy.mode !== 'allow' || !Array.isArray(policy.regions) || policy.regions.length !== 0) {
      return failure('Not found', 404);
    }

    const { data, error } = await service.storage.from('media')
      .download(storagePath, {}, { signal, cache: 'no-store' }).asStream();
    if (error?.status === 404 || error?.statusCode === '404') return failure('Not found', 404);
    if (error || !data) return failure('Media unavailable', 502);
    const playlist = storagePath.endsWith('.m3u8');
    const maxBytes = playlist ? 512 * 1024 : 16 * 1024 * 1024;
    const reader = data.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Media size exceeded');
        chunks.push(value);
      }
    } catch (error) {
      cancel();
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
    if (!size) throw new Error('Empty media');
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        // Publication/source changes must not leave a week-long stale copy.
        'Cache-Control': 'public, max-age=60, s-maxage=60, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    console.warn('media.proxy failed');
    return failure('Media unavailable', 502);
  }
}
