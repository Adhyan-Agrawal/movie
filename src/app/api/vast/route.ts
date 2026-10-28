import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as networkFetch } from 'undici';
import { NextRequest, NextResponse } from 'next/server';
import { getPlaybackCommerceContext, getVastConfiguration } from '@/features/commerce/queries';
import { isPublicAdHost, vastConfigurationSchema } from '@/features/commerce/validation';
import { parseVastXml } from '@/features/ads/vast/parser';
import type { VastCreative } from '@/features/ads/vast/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const HEADERS = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const XML_LIMIT = 256 * 1024;

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 0 || b === 168))
      && !(a === 192 && b === 88 && c === 99) && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      && !(a === 203 && b === 0 && c === 113);
  }
  // Only native global-unicast IPv6. Reject mapped, transition, local and documentation ranges.
  const value = address.toLowerCase();
  const second = parseInt(value.split(':')[1] || '0', 16);
  return isIP(value) === 6 && /^[23][0-9a-f]{3}:/.test(value)
    && !(value.startsWith('2001:') && (second < 0x200 || second === 0xdb8))
    && !value.startsWith('2002:') && !value.startsWith('3fff:');
}

async function beforeAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('VAST resolution timeout'));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
}

export async function GET(request: NextRequest) {
  const empty = () => new NextResponse(null, { status: 204, headers: HEADERS });
  if (request.nextUrl.searchParams.getAll('consent').length !== 1 || request.nextUrl.searchParams.get('consent') !== '1'
    || request.headers.get('sec-fetch-site') === 'cross-site' || request.signal.aborted) return empty();
  let config;
  try {
    const context = await getPlaybackCommerceContext(request);
    if (!context.ads.enabled || !context.entitlements.resolved || context.entitlements.adFree) return empty();
    const parsed = vastConfigurationSchema.safeParse(await getVastConfiguration());
    if (!parsed.success || !parsed.data.enabled) return empty();
    config = parsed.data;
  } catch { return empty(); }
  const allowed = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash
        && (!url.port || url.port === '443') && isPublicAdHost(url.hostname) && config.allowedHosts.includes(url.hostname);
    } catch { return false; }
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const signal = AbortSignal.any([controller.signal, request.signal]);
  const connections: Agent[] = [];
  const visited = new Set<string>();
  const tracking: VastCreative['tracking'] = {};
  const clickTracking = new Set<string>();
  let size = 0;
  let target = config.tagUrl;
  try {
    for (let wrapper = 0; wrapper <= 3; wrapper += 1) {
      let response: Awaited<ReturnType<typeof networkFetch>> | undefined;
      for (let redirect = 0; redirect <= 3; redirect += 1) {
        target = new URL(target).href;
        if (!allowed(target) || visited.has(target)) throw new Error('Unsafe or cyclic VAST URL');
        visited.add(target);
        const url = new URL(target);
        const addresses = await beforeAbort(lookup(url.hostname, { all: true }), signal);
        if (!addresses.length || addresses.some((address) => !publicAddress(address.address))) throw new Error('Private VAST destination');
        signal.throwIfAborted();
        // Pin the verified DNS answers; TLS still verifies the original hostname.
        const dispatcher = new Agent({ connect: { lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        } } });
        connections.push(dispatcher);
        response = await beforeAbort(networkFetch(target, { dispatcher, signal, redirect: 'manual',
          headers: { Accept: 'application/xml,text/xml', 'Accept-Encoding': 'identity' } }), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location || redirect === 3) throw new Error('Invalid VAST redirect');
          target = new URL(location, target).href;
          continue;
        }
        break;
      }
      if (!response?.ok || response.status === 206 || response.headers.has('content-range') || !response.body) {
        await response?.body?.cancel();
        throw new Error('VAST unavailable');
      }
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > XML_LIMIT - size) { await response.body.cancel(); throw new Error('VAST too large'); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let documentSize = 0;
      while (true) {
        signal.throwIfAborted();
        const result = await beforeAbort(reader.read(), signal);
        if (result.done) break;
        size += result.value.byteLength;
        documentSize += result.value.byteLength;
        if (size > XML_LIMIT) { await reader.cancel(); throw new Error('VAST too large'); }
        chunks.push(result.value);
      }
      const bytes = new Uint8Array(documentSize);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      signal.throwIfAborted();
      const parsed = parseVastXml(new TextDecoder('utf-8', { fatal: true }).decode(bytes), target,
        (value) => allowed(value) && !visited.has(value));
      if (!parsed) throw new Error('Unsupported VAST response');
      const events: VastCreative['tracking'] = parsed.kind === 'inline' ? parsed.creative.tracking : parsed.tracking;
      for (const [event, urls] of Object.entries(events)) {
        const key = event as keyof VastCreative['tracking'];
        tracking[key] = [...new Set([...(tracking[key] ?? []), ...(urls ?? [])])].slice(0, 20);
      }
      for (const address of (parsed.kind === 'inline' ? parsed.creative.clickTracking : parsed.clickTracking) ?? []) {
        if (clickTracking.size < 20) clickTracking.add(address);
      }
      if (parsed.kind === 'inline') {
        const skipAfterSeconds = config.allowSkip && parsed.creative.skipAfterSeconds !== null
          ? Math.min(parsed.creative.durationSeconds, Math.max(config.skipAfterSeconds, parsed.creative.skipAfterSeconds)) : null;
        return NextResponse.json({ creative: { ...parsed.creative, skipAfterSeconds, tracking,
          ...(clickTracking.size ? { clickTracking: [...clickTracking] } : {}) } }, { headers: HEADERS });
      }
      target = parsed.url;
    }
    throw new Error('VAST wrapper limit');
  } catch {
    return empty();
  } finally {
    clearTimeout(timeout);
    await Promise.all(connections.map((connection) => connection.destroy().catch(() => {})));
  }
}
