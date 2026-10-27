import { lookup } from 'node:dns/promises';
import { NextRequest, NextResponse } from 'next/server';
import { getPlaybackCommerceContext, getVastConfiguration } from '@/features/commerce/queries';
import { isPublicAdHost } from '@/features/commerce/validation';
import { isPrivateOrLoopbackHost } from '@/lib/validation/source';
import { parseVastXml } from '@/features/ads/vast/parser';
import type { VastCreative } from '@/features/ads/vast/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const XML_LIMIT = 256 * 1024;

async function publicAddresses(hostname: string, signal: AbortSignal) {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('VAST resolution timeout'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get('consent') !== '1') return new NextResponse(null, { status: 204, headers: HEADERS });
  const context = await getPlaybackCommerceContext(request);
  if (!context.ads.enabled || !context.entitlements.resolved || context.entitlements.adFree) return new NextResponse(null, { status: 204, headers: HEADERS });
  const config = await getVastConfiguration();
  if (!config.enabled || !config.tagUrl) return new NextResponse(null, { status: 204, headers: HEADERS });
  const allowed = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
        && (!url.port || url.port === '443') && isPublicAdHost(url.hostname) && config.allowedHosts.includes(url.hostname);
    } catch { return false; }
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const visited = new Set<string>();
  const tracking: VastCreative['tracking'] = {};
  let target = config.tagUrl;
  try {
    for (let wrapper = 0; wrapper <= 3; wrapper += 1) {
      let response: Response | undefined;
      for (let redirect = 0; redirect <= 3; redirect += 1) {
        if (!allowed(target) || visited.has(target)) throw new Error('Unsafe or cyclic VAST URL');
        visited.add(target);
        const url = new URL(target);
        const addresses = await publicAddresses(url.hostname, controller.signal);
        if (!addresses.length || addresses.some((address) => isPrivateOrLoopbackHost(address.address))) throw new Error('Private VAST destination');
        controller.signal.throwIfAborted();
        response = await fetch(target, { signal: controller.signal, cache: 'no-store', redirect: 'manual', headers: { Accept: 'application/xml,text/xml' } });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirect === 3) throw new Error('Invalid VAST redirect');
          target = new URL(location, target).href;
          continue;
        }
        break;
      }
      if (!response?.ok || !response.body) throw new Error('VAST unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > XML_LIMIT) { await reader.cancel(); throw new Error('VAST too large'); }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed = parseVastXml(new TextDecoder().decode(bytes), target, allowed);
      if (!parsed) throw new Error('Unsupported VAST response');
      const events: VastCreative['tracking'] = parsed.kind === 'inline' ? parsed.creative.tracking : parsed.tracking;
      for (const [event, urls] of Object.entries(events)) {
        const key = event as keyof VastCreative['tracking'];
        tracking[key] = [...new Set([...(tracking[key] ?? []), ...(urls ?? [])])].slice(0, 20);
      }
      if (parsed.kind === 'inline') return NextResponse.json({ creative: { ...parsed.creative, tracking } }, { headers: HEADERS });
      target = parsed.url;
    }
    throw new Error('VAST wrapper limit');
  } catch {
    return new NextResponse(null, { status: 204, headers: HEADERS });
  } finally { clearTimeout(timeout); }
}
