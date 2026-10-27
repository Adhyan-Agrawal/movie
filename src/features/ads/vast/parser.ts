import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ParsedVast, VastCreative, VastTrackingEvent } from './types';

type XmlNode = Record<string, unknown>;
const node = (value: unknown): XmlNode => value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value.slice(0, 40) : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : typeof node(value)['#text'] === 'string' ? node(value)['#text'] as string : '';

function decode(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name]!)
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
      const point = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
      return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '';
    });
}

function duration(value: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] ?? '0'}`);
  return Number.isFinite(seconds) && seconds <= 600 ? seconds : null;
}

/** Parses linear VAST only; executable VPAID and external XML entities are never accepted. */
export function parseVastXml(xml: string, baseUrl: string, isAllowed: (url: string) => boolean): ParsedVast | null {
  if (new TextEncoder().encode(xml).byteLength > 256 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) return null;
  if (XMLValidator.validate(xml) !== true) return null;
  const url = (value: unknown): string | undefined => {
    const raw = decode(text(value)).trim();
    if (!raw || raw.length > 4096) return undefined;
    try {
      const target = new URL(raw, baseUrl);
      return target.protocol === 'https:' && !target.username && !target.password && isAllowed(target.href) ? target.href : undefined;
    } catch { return undefined; }
  };
  try {
    const parsed: unknown = new XMLParser({ ignoreAttributes: false, processEntities: false,
      parseTagValue: false, parseAttributeValue: false, removeNSPrefix: true, trimValues: true }).parse(xml);
    const ads = list(node(node(parsed).VAST).Ad).slice(0, 10);
    for (const rawAd of ads) {
      const ad = node(rawAd);
      const wrapper = node(ad.Wrapper);
      const inline = node(ad.InLine);
      const content = Object.keys(wrapper).length ? wrapper : inline;
      if (!Object.keys(content).length) continue;
      const tracking: VastCreative['tracking'] = {};
      const append = (event: VastTrackingEvent, values: unknown[]) => {
        tracking[event] = [...new Set([...(tracking[event] ?? []), ...values.map(url).filter((entry): entry is string => Boolean(entry))])].slice(0, 10);
      };
      append('impression', list(content.Impression));
      append('error', list(content.Error));
      const creatives = list(node(content.Creatives).Creative);
      const linear = creatives.map((entry) => node(node(entry).Linear)).find((entry) => Object.keys(entry).length) ?? {};
      for (const rawEvent of list(node(linear.TrackingEvents).Tracking)) {
        const event = node(rawEvent)['@_event'];
        if (['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'skip', 'error'].includes(String(event))) {
          append(event as VastTrackingEvent, [rawEvent]);
        }
      }
      if (Object.keys(wrapper).length) {
        const target = url(wrapper.VASTAdTagURI ?? wrapper.VASTAdTagURL);
        if (target) return { kind: 'wrapper', url: target, tracking };
        continue;
      }
      const seconds = duration(text(linear.Duration));
      if (seconds === null || seconds <= 0) continue;
      const mediaFiles = list(node(linear.MediaFiles).MediaFile).map((raw) => {
        const file = node(raw);
        const mediaUrl = url(raw);
        const type = String(file['@_type'] ?? '').toLowerCase();
        const bitrate = Number(file['@_bitrate']);
        return mediaUrl && type === 'video/mp4' && !file['@_apiFramework']
          ? { mediaUrl, bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : Infinity } : null;
      }).filter((file): file is { mediaUrl: string; bitrate: number } => file !== null).sort((a, b) => a.bitrate - b.bitrate);
      const media = mediaFiles[0];
      if (!media) continue;
      const rawSkip = String(linear['@_skipoffset'] ?? '');
      const percentage = /^(\d+(?:\.\d+)?)%$/.exec(rawSkip);
      const skipAfterSeconds = percentage && Number(percentage[1]) <= 100
        ? seconds * Number(percentage[1]) / 100 : duration(rawSkip);
      const clicks = node(linear.VideoClicks);
      const clickThrough = url(clicks.ClickThrough);
      const clickTracking = list(clicks.ClickTracking).map(url).filter((entry): entry is string => Boolean(entry)).slice(0, 10);
      return { kind: 'inline', creative: {
        id: String(ad['@_id'] ?? 'vast-linear').slice(0, 128), mediaUrl: media.mediaUrl,
        durationSeconds: seconds, skipAfterSeconds, tracking,
        ...(clickThrough ? { clickThrough } : {}), ...(clickTracking.length ? { clickTracking } : {}),
      } };
    }
  } catch { return null; }
  return null;
}
