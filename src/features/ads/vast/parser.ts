import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { isPublicAdHost } from '@/features/commerce/validation';
import type { ParsedVast, VastCreative, VastTrackingEvent } from './types';

type XmlNode = Record<string, unknown>;
const node = (value: unknown): XmlNode => value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : {};
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value.slice(0, 40) : [value];
const text = (value: unknown): string => typeof value === 'string' ? value : typeof node(value)['#text'] === 'string' ? node(value)['#text'] as string : '';

function decode(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);/g, (_, name: string) => {
    if (name[0] !== '#') return entities[name]!;
    const code = name.slice(1);
    const point = code[0]?.toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : '\u0000';
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
  if (xml.length > 256 * 1024 || new TextEncoder().encode(xml).byteLength > 256 * 1024 || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) return null;
  const url = (value: unknown): string | undefined => {
    const source = text(value);
    if (!source || source.length > 4096 || /&(?!(?:amp|lt|gt|quot|apos|#x[\da-fA-F]+|#\d+);)[a-zA-Z#][^\s&]*;/.test(source)) return undefined;
    const raw = decode(source).trim();
    if (!raw || /[\u0000-\u0020\u007f]/.test(raw)) return undefined;
    try {
      const target = new URL(raw, baseUrl);
      return target.href.length <= 4096 && target.protocol === 'https:' && !target.username && !target.password
        && !target.hash && (!target.port || target.port === '443') && isPublicAdHost(target.hostname)
        && isAllowed(target.href) ? target.href : undefined;
    } catch { return undefined; }
  };
  try {
    if (XMLValidator.validate(xml) !== true) return null;
    const parsed: unknown = new XMLParser({ ignoreAttributes: false, processEntities: false,
      parseTagValue: false, parseAttributeValue: false, removeNSPrefix: true, trimValues: true, maxNestedTags: 32 }).parse(xml);
    const vast = node(node(parsed).VAST);
    if (!/^[234](?:\.\d{1,2})?$/.test(text(vast['@_version']))) return null;
    const ads = list(vast.Ad).slice(0, 10);
    for (const rawAd of ads) {
      const ad = node(rawAd);
      const wrapper = node(ad.Wrapper);
      const inline = node(ad.InLine);
      if (ad.Wrapper !== undefined && ad.InLine !== undefined) continue;
      const content = Object.keys(wrapper).length ? wrapper : inline;
      if (!Object.keys(content).length) continue;
      const tracking: VastCreative['tracking'] = {};
      const append = (event: VastTrackingEvent, values: unknown[]) => {
        const urls = [...new Set([...(tracking[event] ?? []), ...values.map(url).filter((entry): entry is string => Boolean(entry))])].slice(0, 10);
        if (urls.length) tracking[event] = urls;
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
      const clicks = node(linear.VideoClicks);
      const clickTracking = [...new Set(list(clicks.ClickTracking).map(url).filter((entry): entry is string => Boolean(entry)))].slice(0, 10);
      if (Object.keys(wrapper).length) {
        const target = url(wrapper.VASTAdTagURI ?? wrapper.VASTAdTagURL);
        if (target) return { kind: 'wrapper', url: target, tracking, ...(clickTracking.length ? { clickTracking } : {}) };
        continue;
      }
      const seconds = duration(text(linear.Duration));
      if (seconds === null || seconds <= 0) continue;
      const mediaFiles = list(node(linear.MediaFiles).MediaFile).map((raw) => {
        const file = node(raw);
        const mediaUrl = url(raw);
        const type = text(file['@_type']).trim().toLowerCase();
        const bitrate = Number(file['@_bitrate']);
        const supportedBitrate = file['@_bitrate'] === undefined || (/^\d+(?:\.\d+)?$/.test(text(file['@_bitrate'])) && bitrate > 0 && bitrate <= 10000);
        return mediaUrl && type === 'video/mp4' && !file['@_apiFramework'] && supportedBitrate
          && (file['@_delivery'] === undefined || file['@_delivery'] === 'progressive')
          ? { mediaUrl, bitrate: file['@_bitrate'] === undefined ? Infinity : bitrate } : null;
      }).filter((file): file is { mediaUrl: string; bitrate: number } => file !== null).sort((a, b) => a.bitrate - b.bitrate);
      const media = mediaFiles[0];
      if (!media) continue;
      const rawSkip = text(linear['@_skipoffset']);
      const percentage = /^(\d+(?:\.\d+)?)%$/.exec(rawSkip);
      const skipAfterSeconds = percentage && Number(percentage[1]) <= 100
        ? seconds * Number(percentage[1]) / 100 : duration(rawSkip);
      const clickThrough = url(clicks.ClickThrough);
      const rawId = text(ad['@_id']).slice(0, 128);
      return { kind: 'inline', creative: {
        id: /^[a-zA-Z0-9._-]+$/.test(rawId) ? rawId : 'vast-linear', mediaUrl: media.mediaUrl,
        durationSeconds: seconds, skipAfterSeconds: skipAfterSeconds !== null && skipAfterSeconds <= seconds ? skipAfterSeconds : null, tracking,
        ...(clickThrough ? { clickThrough } : {}), ...(clickTracking.length ? { clickTracking } : {}),
      } };
    }
  } catch { return null; }
  return null;
}
