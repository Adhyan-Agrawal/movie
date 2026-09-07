/**
 * Transcode-action state shared between the admin UI and the server action.
 * Kept OUTSIDE the `'use server'` module — a 'use server' file may only export
 * async functions (a plain object export gets compiled into a server-reference
 * proxy on the client and breaks useActionState).
 */
export interface TranscodeActionState {
  status: 'idle' | 'ok' | 'error';
  message: string;
  /** Storage path of the master playlist (`hls/{slug}/…/master.m3u8`). */
  masterPath?: string;
  /** Storage prefix the whole ladder was uploaded under. */
  prefix?: string;
  /** Renditions produced, as height labels ("1080", "720", "480"). */
  renditions?: string[];
  /** Source duration in seconds when ffprobe could read it. */
  durationSeconds?: number;
}

export const TRANSCODE_INITIAL_STATE: TranscodeActionState = { status: 'idle', message: '' };
