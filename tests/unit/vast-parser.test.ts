import { describe, expect, it, vi } from 'vitest';
import { parseVastXml } from '@/features/ads/vast/parser';
import * as parserExports from '@/features/ads/vast/parser';

const ALLOWED = (value: string) => new URL(value).hostname === 'ads.example.com';
const XML = `<VAST version="4.2"><Ad id="one"><InLine><Impression>https://ads.example.com/impression</Impression><Creatives><Creative><Linear skipoffset="25%"><Duration>00:00:20.000</Duration><TrackingEvents><Tracking event="start">https://ads.example.com/start?a=1&amp;b=2</Tracking></TrackingEvents><MediaFiles><MediaFile type="video/mp4" bitrate="800">https://ads.example.com/video.mp4</MediaFile></MediaFiles><VideoClicks><ClickThrough>https://ads.example.com/learn</ClickThrough></VideoClicks></Linear></Creative></Creatives></InLine></Ad></VAST>`;
const BASE = 'https://ads.example.com/tags/current.xml';

function creative(xml: string) {
  const parsed = parseVastXml(xml, BASE, ALLOWED);
  expect(parsed?.kind).toBe('inline');
  if (parsed?.kind !== 'inline') throw new Error('Expected an inline creative');
  return parsed.creative;
}

describe('bounded linear VAST parser', () => {
  it('extracts real media, duration, skip policy, and escaped tracking', () => {
    const parsed = parseVastXml(XML, 'https://ads.example.com/tag', ALLOWED);
    expect(parsed?.kind).toBe('inline');
    if (parsed?.kind !== 'inline') return;
    expect(parsed.creative).toMatchObject({ durationSeconds: 20, skipAfterSeconds: 5, mediaUrl: 'https://ads.example.com/video.mp4' });
    expect(parsed.creative.tracking.start).toEqual(['https://ads.example.com/start?a=1&b=2']);
  });

  it('handles wrappers and namespaced tags without fetching them', () => {
    const wrapper = '<v:VAST version="3.0" xmlns:v="urn:vast"><v:Ad><v:Wrapper><v:VASTAdTagURI>https://ads.example.com/next</v:VASTAdTagURI><v:Impression>https://ads.example.com/wrapper</v:Impression></v:Wrapper></v:Ad></v:VAST>';
    expect(parseVastXml(wrapper, 'https://ads.example.com/tag', ALLOWED)).toMatchObject({ kind: 'wrapper', url: 'https://ads.example.com/next' });
  });

  it('normalizes and deduplicates wrapper click beacons without exposing wrapper tags', () => {
    const wrapper = '<VAST version="4.2"><Ad><Wrapper><VASTAdTagURI>/next</VASTAdTagURI><Creatives><Creative><Linear><VideoClicks><ClickTracking>/click</ClickTracking><ClickTracking>/click</ClickTracking><ClickTracking>javascript:alert(1)</ClickTracking></VideoClicks></Linear></Creative></Creatives></Wrapper></Ad></VAST>';
    expect(parseVastXml(wrapper, BASE, ALLOWED)).toMatchObject({ kind: 'wrapper', clickTracking: ['https://ads.example.com/click'] });
  });

  it('does not reflect URLs or provider query secrets in the public creative ID', () => {
    const parsed = parseVastXml(XML.replace('id="one"', 'id="https://ads.example.com/tag?private=secret"'), BASE, ALLOWED);
    expect(parsed?.kind).toBe('inline');
    if (parsed?.kind === 'inline') expect(parsed.creative.id).toBe('vast-linear');
  });

  it('rejects DTD/entities, oversized payloads, unsafe media, and executable VPAID', () => {
    expect(parseVastXml(`<!DOCTYPE VAST [<!ENTITY x SYSTEM "file:///etc/passwd">]>${XML}`, 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml('a'.repeat(256 * 1024 + 1), 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('https://ads.example.com/video.mp4', 'http://127.0.0.1/video.mp4'), 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('type="video/mp4"', 'type="application/javascript" apiFramework="VPAID"'), 'https://ads.example.com', ALLOWED)).toBeNull();
  });

  it('keeps non-skippable ads non-skippable and accepts valid absolute offsets', () => {
    expect(creative(XML.replace(' skipoffset="25%"', '')).skipAfterSeconds).toBeNull();
    expect(creative(XML.replace('25%', '00:00:07')).skipAfterSeconds).toBe(7);
  });

  it('exports only the specified pure parser and performs no wrapper fetch', () => {
    expect(Object.keys(parserExports)).toEqual(['parseVastXml']);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden in parser tests'); });
    try {
      const wrapper = '<VAST version="2.0"><Ad><Wrapper><VASTAdTagURL>../next.xml</VASTAdTagURL><Error>/error</Error><Impression>/impression</Impression><Creatives><Creative><Linear><TrackingEvents><Tracking event="complete">/complete</Tracking></TrackingEvents></Linear></Creative></Creatives></Wrapper></Ad></VAST>';
      expect(parseVastXml(wrapper, BASE, ALLOWED)).toEqual({ kind: 'wrapper', url: 'https://ads.example.com/next.xml', tracking: {
        error: ['https://ads.example.com/error'], impression: ['https://ads.example.com/impression'], complete: ['https://ads.example.com/complete'],
      } });
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it.each(['2.0', '3.0', '4.0', '4.2'])('accepts VAST %s inline creatives', (version) => {
    expect(creative(XML.replace('4.2', version)).durationSeconds).toBe(20);
  });

  it.each(['1.0', '5.0', 'garbage', '4.2.0'])('rejects unsupported VAST version %s', (version) => {
    expect(parseVastXml(XML.replace('4.2', version), BASE, ALLOWED)).toBeNull();
  });

  it('rejects missing versions, ambiguous inline/wrapper ads, and non-linear-only ads', () => {
    expect(parseVastXml(XML.replace(' version="4.2"', ''), BASE, ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('</Ad>', '<Wrapper><VASTAdTagURI>/next</VASTAdTagURI></Wrapper></Ad>'), BASE, ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace(/Linear/g, 'NonLinear'), BASE, ALLOWED)).toBeNull();
  });

  it('normalizes namespaced relative URLs and sends every output URL through the callback', () => {
    const namespaced = XML.replace(/(<\/?)([A-Za-z]+)/g, '$1v:$2').replace('<v:VAST ', '<v:VAST xmlns:v="urn:vast" ')
      .replaceAll('https://ads.example.com/', '../').replace('</v:VideoClicks>', '<v:ClickTracking>../click</v:ClickTracking></v:VideoClicks>');
    const allowed = vi.fn(ALLOWED);
    const parsed = parseVastXml(namespaced, BASE, allowed);
    expect(parsed).toMatchObject({ kind: 'inline', creative: { mediaUrl: 'https://ads.example.com/video.mp4', clickThrough: 'https://ads.example.com/learn', clickTracking: ['https://ads.example.com/click'] } });
    expect(allowed.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      'https://ads.example.com/video.mp4', 'https://ads.example.com/impression', 'https://ads.example.com/start?a=1&b=2',
      'https://ads.example.com/learn', 'https://ads.example.com/click',
    ]));
  });

  it.each([
    'http://ads.example.com/video.mp4', 'javascript:alert(1)', 'data:video/mp4;base64,AAAA',
    'https://localhost/video.mp4', 'https://127.0.0.1/video.mp4', 'https://2130706433/video.mp4',
    'https://[::1]/video.mp4', 'https://[::ffff:7f00:1]/video.mp4', 'https://10.0.0.1/video.mp4',
    'https://ads.internal/video.mp4', 'https://user:pass@ads.example.com/video.mp4',
    'https://ads.example.com:8443/video.mp4', 'https://ads.example.com/video.mp4#fragment',
    'ht&#0;tps://ads.example.com/video.mp4', 'https://ads.example.com/vi&#10;deo.mp4', 'https://ads.example.com/&custom;',
  ])('rejects unsafe media URL even with a permissive callback: %s', (url) => {
    expect(parseVastXml(XML.replace('https://ads.example.com/video.mp4', url), BASE, () => true)).toBeNull();
  });

  it('denies disallowed media/wrappers and drops disallowed tracking/click URLs', () => {
    expect(parseVastXml(XML.replace('https://ads.example.com/video.mp4', 'https://denied.example.com/video.mp4'), BASE, ALLOWED)).toBeNull();
    expect(parseVastXml('<VAST version="4.0"><Ad><Wrapper><VASTAdTagURI>https://denied.example.com/tag</VASTAdTagURI></Wrapper></Ad></VAST>', BASE, ALLOWED)).toBeNull();
    const denied = XML.replace('https://ads.example.com/impression', 'https://denied.example.com/impression')
      .replace('https://ads.example.com/start?a=1&amp;b=2', 'https://denied.example.com/start')
      .replace('https://ads.example.com/learn', 'https://denied.example.com/learn')
      .replace('</VideoClicks>', '<ClickTracking>https://denied.example.com/click</ClickTracking></VideoClicks>');
    expect(creative(denied).tracking).toEqual({});
    expect(creative(denied).clickThrough).toBeUndefined();
    expect(creative(denied).clickTracking).toBeUndefined();
    expect(parseVastXml(XML, BASE, () => { throw new Error('Policy unavailable'); })).toBeNull();
  });

  it('decodes XML references once and preserves CDATA URLs', () => {
    expect(creative(XML.replace('start?a=1&amp;b=2', 'start?a=1&amp;amp;b=2')).tracking.start).toEqual(['https://ads.example.com/start?a=1&amp;b=2']);
    expect(creative(XML.replace('https://ads.example.com/video.mp4', '<![CDATA[../video.mp4?x=1&y=2]]>')).mediaUrl).toBe('https://ads.example.com/video.mp4?x=1&y=2');
    expect(creative(XML.replace('start?a=1&amp;b=2', 'start?a=1&#38;b=2')).tracking.start).toEqual(['https://ads.example.com/start?a=1&b=2']);
  });

  it.each([
    '<!DOCTYPE VAST>', '<!doctype VAST SYSTEM "https://attacker.example/dtd">',
    '<!ENTITY external SYSTEM "file:///etc/passwd">', '<!DOCTYPE VAST [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;">]>',
  ])('rejects XML declarations without entity expansion: %s', (declaration) => {
    expect(parseVastXml(declaration + XML, BASE, ALLOWED)).toBeNull();
  });

  it('bounds UTF-8 bytes, nesting, field length, and scanned media arrays', () => {
    const padding = 256 * 1024 - new TextEncoder().encode(XML).byteLength - 7;
    expect(creative(XML + '<!--' + 'a'.repeat(padding) + '-->').mediaUrl).toBe('https://ads.example.com/video.mp4');
    expect(parseVastXml(XML + '<!--' + 'a'.repeat(padding + 1) + '-->', BASE, ALLOWED)).toBeNull();
    const multibyte = XML + '<!--' + String.fromCharCode(233).repeat(140000) + '-->';
    expect(multibyte.length).toBeLessThan(256 * 1024);
    expect(parseVastXml(multibyte, BASE, ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('</InLine>', '<Extensions>' + '<x>'.repeat(40) + '</x>'.repeat(40) + '</Extensions></InLine>'), BASE, ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('https://ads.example.com/video.mp4', 'https://ads.example.com/' + 'a'.repeat(4096)), BASE, ALLOWED)).toBeNull();
    expect(creative(XML.replace('id="one"', 'id="' + 'a'.repeat(200) + '"')).id).toHaveLength(128);
    const media = '<MediaFile type="video/webm">/unsupported.webm</MediaFile>'.repeat(40) + '<MediaFile type="video/mp4">/valid.mp4</MediaFile>';
    expect(parseVastXml(XML.replace(/<MediaFiles>.*?<\/MediaFiles>/, '<MediaFiles>' + media + '</MediaFiles>'), BASE, ALLOWED)).toBeNull();
  });

  it('copies only supported events and deduplicates/caps tracking and clicks', () => {
    const events = Array.from({ length: 20 }, (_, index) => `<Tracking event="start">/track/${index}</Tracking><Tracking event="start">/track/${index}</Tracking>`).join('');
    const clicks = Array.from({ length: 20 }, (_, index) => `<ClickTracking>/click/${index}</ClickTracking><ClickTracking>/click/${index}</ClickTracking>`).join('');
    const parsed = creative(XML.replace(/<TrackingEvents>.*?<\/TrackingEvents>/, `<TrackingEvents>${events}<Tracking event="pause">/ignored</Tracking><Tracking event="__proto__">/ignored</Tracking></TrackingEvents>`)
      .replace('</VideoClicks>', clicks + '</VideoClicks>'));
    expect(parsed.tracking.start).toEqual(Array.from({ length: 10 }, (_, index) => `https://ads.example.com/track/${index}`));
    expect(Object.keys(parsed.tracking).sort()).toEqual(['impression', 'start']);
    expect(parsed.clickTracking).toEqual(Array.from({ length: 10 }, (_, index) => `https://ads.example.com/click/${index}`));
    const supported = ['start', 'firstQuartile', 'midpoint', 'thirdQuartile', 'complete', 'skip', 'error'];
    const all = creative(XML.replace(/<TrackingEvents>.*?<\/TrackingEvents>/, '<TrackingEvents>' + supported.map((event) => `<Tracking event="${event}">/${event}</Tracking>`).join('') + '</TrackingEvents>'));
    expect(Object.keys(all.tracking).sort()).toEqual(['impression', ...supported].sort());
  });

  it.each(['video/webm', 'video/x-flv', 'application/javascript', 'application/x-shockwave-flash'])('rejects unsupported media MIME %s', (type) => {
    expect(parseVastXml(XML.replace('video/mp4', type), BASE, ALLOWED)).toBeNull();
  });

  it.each(['0', '-1', '10001', 'Infinity', 'NaN', '1e3', 'garbage'])('rejects unsupported bitrate %s', (bitrate) => {
    expect(parseVastXml(XML.replace('bitrate="800"', `bitrate="${bitrate}"`), BASE, ALLOWED)).toBeNull();
  });

  it('selects the lowest supported MP4 bitrate and permits omitted bitrate', () => {
    const media = '<MediaFiles><MediaFile type="video/mp4" apiFramework="VPAID" bitrate="1">/executable.mp4</MediaFile><MediaFile type="video/mp4" bitrate="20000">/too-large.mp4</MediaFile><MediaFile type="video/mp4" bitrate="1500">/high.mp4</MediaFile><MediaFile type="video/mp4" delivery="progressive" bitrate="800">/normal.mp4</MediaFile><MediaFile type="video/mp4">/unspecified.mp4</MediaFile></MediaFiles>';
    expect(creative(XML.replace(/<MediaFiles>.*?<\/MediaFiles>/, media)).mediaUrl).toBe('https://ads.example.com/normal.mp4');
    expect(creative(XML.replace(' bitrate="800"', '')).mediaUrl).toBe('https://ads.example.com/video.mp4');
    expect(parseVastXml(XML.replace('type="video/mp4"', 'type="video/mp4" delivery="streaming"'), BASE, ALLOWED)).toBeNull();
  });

  it.each(['00:00:00', '00:10:00.001', '00:60:00', '00:00:60', '01:00:00', '0:00:20', '20', '00:00:20.1234', '-00:00:20'])('rejects invalid duration %s', (duration) => {
    expect(parseVastXml(XML.replace('00:00:20.000', duration), BASE, ALLOWED)).toBeNull();
  });

  it.each([['00:00:00.001', 0.001], ['00:00:20.123', 20.123], ['00:10:00', 600]] as const)('parses strict bounded duration %s', (duration, seconds) => {
    expect(creative(XML.replace('00:00:20.000', duration)).durationSeconds).toBe(seconds);
  });

  it.each([
    ['0%', 0], ['100%', 20], ['12.5%', 2.5], ['00:00:00', 0], ['00:00:07.125', 7.125], ['00:00:20', 20],
    ['101%', null], ['-1%', null], ['garbage', null], ['00:00:21', null], ['00:00:60', null], ['00:10:00.001', null],
  ] as const)('normalizes skip offset %s to %s', (skip, seconds) => {
    expect(creative(XML.replace('25%', skip)).skipAfterSeconds).toBe(seconds);
  });

  it('rejects malformed XML without throwing', () => {
    for (const malformed of [XML.slice(0, -5), XML.replace('</Linear>', '</MediaFile>'), XML.replace('id="one"', 'id="one" id="two"'), '<not-vast/>']) {
      expect(parseVastXml(malformed, BASE, ALLOWED)).toBeNull();
    }
  });
});
