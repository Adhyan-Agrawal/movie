export type VastTrackingEvent = 'impression' | 'start' | 'firstQuartile' | 'midpoint' | 'thirdQuartile' | 'complete' | 'skip' | 'error';

export interface VastCreative {
  id: string;
  mediaUrl: string;
  durationSeconds: number;
  skipAfterSeconds: number | null;
  tracking: Partial<Record<VastTrackingEvent, string[]>>;
  clickThrough?: string;
  clickTracking?: string[];
}

export type ParsedVast = { kind: 'inline'; creative: VastCreative }
  | { kind: 'wrapper'; url: string; tracking: VastCreative['tracking'] };
