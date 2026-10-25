import { describe, expect, it } from 'vitest';
import { parseMpegTsAudioLanguages } from '@/lib/providers/mpeg-ts-metadata';

function section(table: number[]): Uint8Array {
  const bytes = [...table];
  const length = bytes.length + 4 - 3;
  bytes[1] = 0xb0 | (length >> 8); bytes[2] = length & 255;
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return new Uint8Array([...bytes, (crc >>> 24) & 255, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255]);
}

function packets(pid: number, table: Uint8Array, firstPayload = 184, pointer = 0): Uint8Array[] {
  const output: Uint8Array[] = [];
  let offset = 0;
  while (offset < table.length) {
    const first = output.length === 0;
    const capacity = first ? firstPayload : 184;
    const packet = new Uint8Array(188).fill(255);
    packet.set([0x47, (first ? 0x40 : 0) | (pid >> 8), pid & 255, (capacity < 184 ? 0x30 : 0x10) | output.length]);
    let start = 4;
    if (capacity < 184) {
      packet[4] = 183 - capacity; packet[5] = 0;
      start += 184 - capacity;
    }
    if (first) { packet[start++] = pointer; start += pointer; }
    const count = Math.min(table.length - offset, 188 - start);
    packet.set(table.subarray(offset, offset + count), start);
    offset += count; output.push(packet);
  }
  return output;
}

function language(value: string): number[] {
  return [0x0a, 4, ...Array.from(value, (character) => character.charCodeAt(0)), 0];
}

function pmt(streams: Array<{ type?: number; pid?: number; descriptors: number[] }>): Uint8Array {
  return section([2, 0, 0, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, ...streams.flatMap((stream, index) => {
    const pid = stream.pid ?? 0x101 + index;
    return [stream.type ?? 0x0f, 0xe0 | (pid >> 8), pid & 255,
      0xf0 | (stream.descriptors.length >> 8), stream.descriptors.length & 255, ...stream.descriptors];
  })]);
}

const pat = () => section([0, 0, 0, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0]);
const join = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
const sample = (streams: Parameters<typeof pmt>[0]) => join([...packets(0, pat()), ...packets(0x100, pmt(streams))]);

describe('bounded MPEG-TS audio language descriptors', () => {
  it.each([0x0f, 0x11, 0x03, 0x04])('reads ISO-639 only from audio ES type %i', (type) => {
    expect(parseMpegTsAudioLanguages(sample([
      { type: 0x1b, descriptors: language('eng') }, { type, descriptors: language('HIN') },
    ]))).toEqual({ complete: true, audioLanguages: ['hin'] });
  });

  it('reassembles section headers, descriptors, and CRC across packets with adaptation and pointer fields', () => {
    const table = pmt([{ descriptors: [0x52, 200, ...new Array(200).fill(0), ...language('eng')] }]);
    expect(parseMpegTsAudioLanguages(join([...packets(0, pat(), 3), ...packets(0x100, table, 30, 2)])))
      .toEqual({ complete: true, audioLanguages: ['eng'] });
  });

  it('reports two languages only for separate elementary PIDs, without duplicating repeated tables', () => {
    const tablePackets = packets(0x100, pmt([{ descriptors: language('eng') }, { descriptors: language('hin') }]));
    expect(parseMpegTsAudioLanguages(join([...packets(0, pat()), ...tablePackets, ...tablePackets])))
      .toEqual({ complete: true, audioLanguages: ['eng', 'hin'] });
    expect(parseMpegTsAudioLanguages(sample([{ descriptors: [0x0a, 8, ...language('eng').slice(2), ...language('hin').slice(2)] }])))
      .toEqual({ complete: true, audioLanguages: ['eng'] });
  });

  it('keeps distinct same-language elementary streams but rejects duplicate PIDs', () => {
    expect(parseMpegTsAudioLanguages(sample([{ descriptors: language('eng') }, { descriptors: language('eng') }])).audioLanguages)
      .toEqual(['eng', 'eng']);
    expect(parseMpegTsAudioLanguages(sample([{ pid: 257, descriptors: language('eng') }, { pid: 257, descriptors: language('hin') }])))
      .toEqual({ complete: false, audioLanguages: [] });
  });

  it('waits for all current PAT and PMT sections across multiple programs', () => {
    const pat0 = section([0, 0, 0, 0, 1, 0xc1, 0, 1, 0, 1, 0xe1, 0]);
    const pat1 = section([0, 0, 0, 0, 1, 0xc1, 1, 1, 0, 2, 0xe1, 0x10]);
    const english = [...pmt([{ pid: 257, descriptors: language('eng') }]).subarray(0, -4)];
    english[7] = 1;
    const hindi = [...pmt([{ pid: 258, descriptors: language('hin') }]).subarray(0, -4)];
    hindi[6] = hindi[7] = 1;
    const untagged = [...pmt([{ pid: 259, descriptors: [] }]).subarray(0, -4)];
    untagged[4] = 2;
    const partial = [...packets(0, pat0), ...packets(0, pat1).map((packet) => {
      const next = packet.slice(); next[3] = 0x11; return next;
    }), ...packets(0x100, section(english))];
    expect(parseMpegTsAudioLanguages(join(partial))).toEqual({ complete: false, audioLanguages: [] });
    const next = packets(0x100, section(hindi)); next[0]![3] = 0x11;
    expect(parseMpegTsAudioLanguages(join([...partial, ...next, ...packets(0x110, section(untagged))])))
      .toEqual({ complete: true, audioLanguages: ['eng', 'hin'] });
  });

  it.each([[], language('und'), language('mul'), language('zxx'), language('12!')].map((descriptors) => ({ descriptors })))('does not invent untagged languages ($descriptors)', ({ descriptors }) => {
    expect(parseMpegTsAudioLanguages(sample([{ descriptors }]))).toEqual({ complete: true, audioLanguages: [] });
  });

  it.each([[0x6a, 1, 0], [0x7a, 1, 0], [0x05, 4, 65, 67, 45, 51], [0x05, 4, 69, 65, 67, 51]])(
    'recognizes private AC-3/E-AC-3 only with identifying descriptors (%j)', (...descriptor) => {
      expect(parseMpegTsAudioLanguages(sample([{ type: 0x06, descriptors: [...descriptor, ...language('eng')] }])).audioLanguages).toEqual(['eng']);
      expect(parseMpegTsAudioLanguages(sample([{ type: 0x06, descriptors: language('eng') }])).audioLanguages).toEqual([]);
    },
  );

  it('requires the PAT-mapped PMT and a current CRC-valid complete section', () => {
    const valid = pmt([{ descriptors: language('eng') }]);
    const corrupt = valid.slice(); corrupt[18] = corrupt[18]! ^ 1;
    for (const parts of [packets(0x100, valid), [...packets(0, pat()), ...packets(0x200, valid)],
      [...packets(0, pat()), ...packets(0x100, corrupt)], [...packets(0, pat()), ...packets(0x100, valid.subarray(0, -1))]]) {
      expect(parseMpegTsAudioLanguages(join(parts))).toEqual({ complete: false, audioLanguages: [] });
    }
    const future = valid.slice(0, -4); future[5] = future[5]! & 0xfe;
    expect(parseMpegTsAudioLanguages(join([...packets(0, pat()), ...packets(0x100, section([...future]))])).audioLanguages).toEqual([]);
  });

  it('rejects truncated descriptors even when their table CRC is valid', () => {
    const malformed = pmt([{ descriptors: [0x0a, 8, 101, 110, 103, 0] }]);
    expect(parseMpegTsAudioLanguages(join([...packets(0, pat()), ...packets(0x100, malformed)])))
      .toEqual({ complete: false, audioLanguages: [] });
  });

  it('rejects continuity gaps, transport errors, scrambling, and corrupt packet boundaries', () => {
    const original = packets(0x100, pmt([{ descriptors: [0x52, 200, ...new Array(200).fill(0), ...language('eng')] }]));
    for (const mutate of [(packet: Uint8Array) => { packet[3] = 0x13; },
      (packet: Uint8Array) => { packet[1] = packet[1]! | 0x80; }, (packet: Uint8Array) => { packet[3] = packet[3]! | 0x80; },
      (packet: Uint8Array) => { packet[0] = 0; }]) {
      const parts = original.map((packet) => packet.slice()); mutate(parts[1]!);
      expect(parseMpegTsAudioLanguages(join([...packets(0, pat()), ...parts]))).toEqual({ complete: false, audioLanguages: [] });
    }
  });

  it('does not inspect bytes beyond the 256 KiB cap or trailing incomplete packets', () => {
    const bounded = new Uint8Array(256 * 1024 + 1024);
    bounded.set(sample([{ descriptors: language('hin') }]), 256 * 1024);
    expect(parseMpegTsAudioLanguages(bounded)).toEqual({ complete: false, audioLanguages: [] });
    expect(parseMpegTsAudioLanguages(sample([{ descriptors: language('hin') }]).subarray(0, 375)))
      .toEqual({ complete: false, audioLanguages: [] });
  });
});
