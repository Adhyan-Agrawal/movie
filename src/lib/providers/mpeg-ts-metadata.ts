import { metadataLanguage } from './hls-metadata';

type Section = { bytes: Uint8Array; length: number; expected: number; counter?: number };
type AudioStream = { pid: number; language: string };
type Program = { version: number; last: number; sections: Map<number, AudioStream[]> };

/** Decode only bounded, CRC-checked PSI tables, never PES payloads or guessed languages. */
export function parseMpegTsAudioLanguages(input: Uint8Array): { complete: boolean; audioLanguages: string[] } {
  const bytes = input.subarray(0, 256 * 1024);
  const sections = new Map<number, Section>();
  const pmtPids = new Map<number, number>();
  const programs = new Map<number, Program>();
  const patSections = new Set<number>();
  let patVersion = -1;
  let patLast = -1;

  const accept = (pid: number, table: Uint8Array) => {
    if (table.length < 12 || !(table[1]! & 0x80) || !(table[5]! & 1) || table[6]! > table[7]!) return;
    let crc = 0xffffffff;
    for (const byte of table) {
      crc ^= byte << 24;
      for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
    }
    if (crc !== 0) return;
    const end = table.length - 4;
    const version = (table[5]! >> 1) & 31;
    const number = table[6]!;
    const last = table[7]!;
    if (pid === 0 && table[0] === 0) {
      if ((end - 8) % 4) return;
      if (patVersion !== version || patLast !== last) {
        pmtPids.clear(); programs.clear(); patSections.clear();
        patVersion = version; patLast = last;
      }
      for (let offset = 8; offset < end; offset += 4) {
        const program = (table[offset]! << 8) | table[offset + 1]!;
        const pmtPid = ((table[offset + 2]! & 31) << 8) | table[offset + 3]!;
        if (program && pmtPid > 0 && pmtPid < 0x1fff) pmtPids.set(pmtPid, program);
      }
      patSections.add(number);
      return;
    }
    if (table[0] !== 2 || table.length < 16 || pmtPids.get(pid) !== ((table[3]! << 8) | table[4]!)) return;
    let offset = 12 + (((table[10]! & 15) << 8) | table[11]!);
    if (offset > end) return;
    const audio: AudioStream[] = [];
    const seen = new Set<number>();
    while (offset < end) {
      if (offset + 5 > end) return;
      const type = table[offset]!;
      const esPid = ((table[offset + 1]! & 31) << 8) | table[offset + 2]!;
      const descriptorEnd = offset + 5 + (((table[offset + 3]! & 15) << 8) | table[offset + 4]!);
      if (descriptorEnd > end || !esPid || esPid === 0x1fff || seen.has(esPid)) return;
      seen.add(esPid);
      let language = '';
      let privateAudio = false;
      for (let descriptor = offset + 5; descriptor < descriptorEnd;) {
        if (descriptor + 2 > descriptorEnd) return;
        const tag = table[descriptor]!;
        const length = table[descriptor + 1]!;
        const start = descriptor + 2;
        if (start + length > descriptorEnd) return;
        if (tag === 0x0a) {
          if (!length || length % 4) return;
          // Multiple ISO-639 entries describe one ES, not additional selectable audio streams.
          for (let entry = start; entry < start + length && !language; entry += 4) {
            const value = metadataLanguage(String.fromCharCode(...table.subarray(entry, entry + 3))).toLowerCase();
            if (/^[a-z]{3}$/.test(value) && !['und', 'mul', 'zxx'].includes(value)) language = value;
          }
        }
        if ((tag === 0x6a || tag === 0x7a) && length >= 1) privateAudio = true;
        if (tag === 0x05 && length >= 4) {
          privateAudio ||= ['AC-3', 'EAC3'].includes(String.fromCharCode(...table.subarray(start, start + 4)));
        }
        descriptor = start + length;
      }
      if (language && ([0x0f, 0x11, 0x03, 0x04].includes(type) || (type === 0x06 && privateAudio))) {
        audio.push({ pid: esPid, language });
      }
      offset = descriptorEnd;
    }
    let program = programs.get(pid);
    if (!program || program.version !== version || program.last !== last) {
      program = { version, last, sections: new Map() };
      programs.set(pid, program);
    }
    program.sections.set(number, audio);
  };

  const append = (pid: number, state: Section, payload: Uint8Array, allowNew: boolean) => {
    let offset = 0;
    while (offset < payload.length) {
      if (!state.length && (!allowNew || payload[offset] === 0xff)) return;
      const count = Math.min((state.expected || 3) - state.length, payload.length - offset);
      state.bytes.set(payload.subarray(offset, offset + count), state.length);
      state.length += count;
      offset += count;
      if (!state.expected && state.length === 3) {
        state.expected = 3 + (((state.bytes[1]! & 15) << 8) | state.bytes[2]!);
        if (state.expected < 12 || state.expected > 1024) { state.length = state.expected = 0; return; }
      }
      if (state.expected && state.length === state.expected) {
        accept(pid, state.bytes.subarray(0, state.length));
        state.length = state.expected = 0;
        if (!allowNew) return;
      }
    }
  };

  for (let offset = 0; offset + 188 <= bytes.length; offset += 188) {
    const packet = bytes.subarray(offset, offset + 188);
    if (packet[0] !== 0x47) break;
    const pid = ((packet[1]! & 31) << 8) | packet[2]!;
    if (pid !== 0 && !pmtPids.has(pid)) continue;
    const control = (packet[3]! >> 4) & 3;
    if ((packet[1]! & 0x80) || (packet[3]! & 0xc0) || !control) { sections.delete(pid); continue; }
    let payloadOffset = 4;
    if (control & 2) {
      if (packet[4]! > 183) { sections.delete(pid); continue; }
      if (packet[4]! && (packet[5]! & 0x80)) sections.delete(pid);
      payloadOffset += 1 + packet[4]!;
    }
    if (!(control & 1) || payloadOffset >= 188) continue;
    let state = sections.get(pid);
    if (!state) { state = { bytes: new Uint8Array(1024), length: 0, expected: 0 }; sections.set(pid, state); }
    const counter = packet[3]! & 15;
    if (state.counter === counter) continue;
    if (state.counter !== undefined && counter !== ((state.counter + 1) & 15)) state.length = state.expected = 0;
    state.counter = counter;
    const payload = packet.subarray(payloadOffset);
    if (packet[1]! & 0x40) {
      const pointer = payload[0]!;
      if (pointer + 1 > payload.length) { state.length = state.expected = 0; continue; }
      if (state.length && pointer) append(pid, state, payload.subarray(1, pointer + 1), false);
      state.length = state.expected = 0;
      append(pid, state, payload.subarray(pointer + 1), true);
    } else if (state.length) append(pid, state, payload, true);
  }
  const audio = new Map<number, string>();
  const complete = patLast >= 0 && patSections.size === patLast + 1 && pmtPids.size > 0
    && [...pmtPids.keys()].every((pid) => {
      const program = programs.get(pid);
      return program && program.sections.size === program.last + 1;
    });
  if (complete) for (const pid of pmtPids.keys()) {
    const program = programs.get(pid)!;
    for (let number = 0; number <= program.last; number++) {
      for (const stream of program.sections.get(number)!) audio.set(stream.pid, stream.language);
    }
  }
  return { complete, audioLanguages: [...audio.values()] };
}
