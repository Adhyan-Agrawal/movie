import { describe, expect, it } from 'vitest';
import { parseVastXml } from '@/features/ads/vast/parser';

const ALLOWED = (value: string) => new URL(value).hostname === 'ads.example.com';
const XML = `<VAST version="4.2"><Ad id="one"><InLine><Impression>https://ads.example.com/impression</Impression><Creatives><Creative><Linear skipoffset="25%"><Duration>00:00:20.000</Duration><TrackingEvents><Tracking event="start">https://ads.example.com/start?a=1&amp;b=2</Tracking></TrackingEvents><MediaFiles><MediaFile type="video/mp4" bitrate="800">https://ads.example.com/video.mp4</MediaFile></MediaFiles><VideoClicks><ClickThrough>https://ads.example.com/learn</ClickThrough></VideoClicks></Linear></Creative></Creatives></InLine></Ad></VAST>`;

describe('bounded linear VAST parser', () => {
  it('extracts real media, duration, skip policy, and escaped tracking', () => {
    const parsed = parseVastXml(XML, 'https://ads.example.com/tag', ALLOWED);
    expect(parsed?.kind).toBe('inline');
    if (parsed?.kind !== 'inline') return;
    expect(parsed.creative).toMatchObject({ durationSeconds: 20, skipAfterSeconds: 5, mediaUrl: 'https://ads.example.com/video.mp4' });
    expect(parsed.creative.tracking.start).toEqual(['https://ads.example.com/start?a=1&b=2']);
  });

  it('handles wrappers and namespaced tags without fetching them', () => {
    const wrapper = '<v:VAST xmlns:v="urn:vast"><v:Ad><v:Wrapper><v:VASTAdTagURI>https://ads.example.com/next</v:VASTAdTagURI><v:Impression>https://ads.example.com/wrapper</v:Impression></v:Wrapper></v:Ad></v:VAST>';
    expect(parseVastXml(wrapper, 'https://ads.example.com/tag', ALLOWED)).toMatchObject({ kind: 'wrapper', url: 'https://ads.example.com/next' });
  });

  it('rejects DTD/entities, oversized payloads, unsafe media, and executable VPAID', () => {
    expect(parseVastXml(`<!DOCTYPE VAST [<!ENTITY x SYSTEM "file:///etc/passwd">]>${XML}`, 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml('a'.repeat(256 * 1024 + 1), 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('https://ads.example.com/video.mp4', 'http://127.0.0.1/video.mp4'), 'https://ads.example.com', ALLOWED)).toBeNull();
    expect(parseVastXml(XML.replace('type="video/mp4"', 'type="application/javascript" apiFramework="VPAID"'), 'https://ads.example.com', ALLOWED)).toBeNull();
  });

  it('keeps non-skippable ads non-skippable and accepts valid absolute offsets', () => {
    const missing = parseVastXml(XML.replace(' skipoffset="25%"', ''), 'https://ads.example.com', ALLOWED);
    if (missing?.kind === 'inline') expect(missing.creative.skipAfterSeconds).toBeNull();
    const explicit = parseVastXml(XML.replace('25%', '00:00:07'), 'https://ads.example.com', ALLOWED);
    if (explicit?.kind === 'inline') expect(explicit.creative.skipAfterSeconds).toBe(7);
  });
});
