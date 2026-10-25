export interface CastingMedia {
  url: string;
  contentType: string;
  title?: string;
  posterUrl?: string;
  positionSeconds: number;
  autoplay: boolean;
}

export interface CastingProgress {
  positionSeconds: number;
  durationSeconds?: number;
  paused: boolean;
}

export interface CastingHandle {
  deviceName: string;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

interface CastMetadata { title?: string; images?: Array<{ url: string }> }
interface CastMediaInfo { duration?: number; metadata?: CastMetadata }
interface CastLoadRequest { currentTime: number; autoplay: boolean }
interface CastSeekRequest { currentTime: number }
type CastSuccess = () => void;
type CastFailure = (error: unknown) => void;
type MediaListener = (alive: boolean) => void;
interface CastMediaSession {
  media: CastMediaInfo;
  playerState: string;
  getEstimatedTime(): number;
  addUpdateListener(listener: MediaListener): void;
  removeUpdateListener(listener: MediaListener): void;
  play(request: object, success: CastSuccess, failure: CastFailure): void;
  pause(request: object, success: CastSuccess, failure: CastFailure): void;
  seek(request: CastSeekRequest, success: CastSuccess, failure: CastFailure): void;
}
interface CastSession {
  loadMedia(request: CastLoadRequest): Promise<unknown>;
  getMediaSession(): CastMediaSession | null;
  getCastDevice(): { friendlyName?: string };
  endSession(stopCasting: boolean): void;
}
interface SessionEvent { sessionState: string; session?: CastSession | null }
type SessionListener = (event: SessionEvent) => void;
interface CastContext {
  setOptions(options: { receiverApplicationId: string; autoJoinPolicy: string }): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CastSession | null;
  addEventListener(type: string, listener: SessionListener): void;
  removeEventListener(type: string, listener: SessionListener): void;
}
interface CastApi {
  isAvailable?: boolean;
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  media: {
    MediaInfo: new (url: string, contentType: string) => CastMediaInfo;
    GenericMediaMetadata: new () => CastMetadata;
    LoadRequest: new (info: CastMediaInfo) => CastLoadRequest;
    PlayRequest: new () => object;
    PauseRequest: new () => object;
    SeekRequest: new () => CastSeekRequest;
  };
}
interface CastFramework {
  CastContext: { getInstance(): CastContext };
  CastContextEventType: { SESSION_STATE_CHANGED: string };
}
interface CastSdk { api: CastApi; framework: CastFramework }
type AvailabilityCallback = (available: boolean) => void;
type CastWindow = Window & {
  chrome?: { cast?: CastApi };
  cast?: { framework?: CastFramework };
  __onGCastApiAvailable?: AvailabilityCallback;
};
type CastingVideo = HTMLVideoElement & { webkitShowPlaybackTargetPicker?: () => void };

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
const SDK_TIMEOUT_MS = 10_000;
let sdkLoading: Promise<CastSdk> | undefined;

function castingError(message: string): Error {
  const error = new Error(message);
  error.name = 'CastingError';
  return error;
}

function publicMediaUrl(value: string): string {
  let url: URL;
  try { url = new URL(value, window.location.href); }
  catch { throw castingError('This video does not have a playable Cast URL.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : null;
  const [a = 0, b = 0, c = 0] = ipv4 ?? [];
  const privateIpv4 = ipv4 && (a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
  // A receiver cannot use MSE blobs, browser credentials or local development URLs.
  const localHost = !host.includes('.') || /(?:^|\.)(?:localhost|local|localdomain|lan|home|internal|test|invalid)$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || localHost || privateIpv4 || host.includes(':')) {
    throw castingError('Google Cast needs a public HTTPS video URL accessible to your TV without signing in. Local, private and browser-only video URLs cannot be cast.');
  }
  return url.href;
}

function readSdk(target: CastWindow): CastSdk | undefined {
  const api = target.chrome?.cast;
  const framework = target.cast?.framework;
  return api && api.isAvailable !== false && framework ? { api, framework } : undefined;
}

function loadSdk(target: CastWindow): Promise<CastSdk> {
  const ready = readSdk(target);
  if (ready) return Promise.resolve(ready);
  if (sdkLoading) return sdkLoading;
  sdkLoading = new Promise<CastSdk>((resolve, reject) => {
    const previous = target.__onGCastApiAvailable;
    const script = document.createElement('script');
    let settled = false;
    const timer = setTimeout(() => finish(), SDK_TIMEOUT_MS);
    const finish = (sdk?: CastSdk) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      script.remove();
      // The sender bootstrap temporarily wraps this callback while its framework loads.
      if (previous) target.__onGCastApiAvailable = previous;
      else delete target.__onGCastApiAvailable;
      if (sdk) resolve(sdk);
      else reject(castingError('Google Cast could not start. Use desktop Chrome, allow the Cast SDK, and try again.'));
    };
    try {
      target.__onGCastApiAvailable = (available) => {
        finish(available ? readSdk(target) : undefined);
        try { previous?.(available); } catch { /* Other SDK consumers cannot prevent cleanup. */ }
      };
      script.async = true;
      script.src = SDK_URL;
      script.onerror = () => finish();
      script.onload = () => { const sdk = readSdk(target); if (sdk) finish(sdk); };
      (document.head ?? document.documentElement).appendChild(script);
    }
    catch { finish(); }
  }).catch(() => {
    sdkLoading = undefined;
    throw castingError('Google Cast could not start. Use desktop Chrome, allow the Cast SDK, and try again.');
  });
  return sdkLoading;
}

export async function requestCasting(
  video: HTMLVideoElement,
  media: CastingMedia,
  onProgress: (progress: CastingProgress) => void,
  onDisconnect: () => void,
): Promise<CastingHandle | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw castingError('Casting is available only in a supported browser.');
  }
  const nativeVideo = video as CastingVideo;
  if (typeof nativeVideo.webkitShowPlaybackTargetPicker === 'function') {
    try { nativeVideo.webkitShowPlaybackTargetPicker(); return null; }
    catch { throw castingError('AirPlay could not open. Select Cast again from the player.'); }
  }
  if (typeof video.remote?.prompt === 'function') {
    try { await video.remote.prompt(); return null; }
    catch (error: unknown) {
      // Chrome can expose RemotePlayback but reject MSE/adaptive video as unsupported.
      if (!(typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotSupportedError')) {
        throw castingError('The device picker was closed or could not open. Select Cast again to retry.');
      }
    }
  }

  const url = publicMediaUrl(media.url);
  if (!media.contentType.trim() || !Number.isFinite(media.positionSeconds) || media.positionSeconds < 0) {
    throw castingError('This video is not ready to cast. Start playback and try again.');
  }
  const target = window as CastWindow;
  if (!readSdk(target) && (!/Chrome\//.test(window.navigator.userAgent) || /Android|Edg\/|OPR\//.test(window.navigator.userAgent))) {
    throw castingError('Google Cast requires desktop Chrome. Use AirPlay or your browser device picker on other browsers.');
  }
  const sdk = await loadSdk(target);
  let session: CastSession | null = null;
  let cleanup = () => {};
  try {
    const context = sdk.framework.CastContext.getInstance();
    context.setOptions({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: sdk.api.AutoJoinPolicy.ORIGIN_SCOPED });
    await context.requestSession();
    session = context.getCurrentSession();
    if (!session) throw castingError('No Cast device connected. Select Cast again to retry.');
    const info = new sdk.api.media.MediaInfo(url, media.contentType);
    const metadata = new sdk.api.media.GenericMediaMetadata();
    if (media.title) metadata.title = media.title;
    if (media.posterUrl) {
      try { metadata.images = [{ url: publicMediaUrl(media.posterUrl) }]; }
      catch { /* Optional artwork must not send credentials or prevent playback. */ }
    }
    info.metadata = metadata;
    const request = new sdk.api.media.LoadRequest(info);
    request.currentTime = media.positionSeconds;
    request.autoplay = media.autoplay;
    await session.loadMedia(request);
    const receiver = session.getMediaSession();
    if (!receiver || context.getCurrentSession() !== session) throw castingError('The TV could not load this video.');
    const connectedSession = session;
    const eventType = sdk.framework.CastContextEventType.SESSION_STATE_CHANGED;
    let disposed = false;
    let stopped = false;
    let disconnected = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      try { receiver.removeUpdateListener(update); } catch { /* A vanished receiver may already be detached. */ }
      try { context.removeEventListener(eventType, sessionChanged); } catch { /* Always clear the timer as well. */ }
    };
    const disconnect = () => {
      if (disposed || disconnected) return;
      disconnected = true;
      cleanup();
      try { onDisconnect(); } catch { /* UI callbacks must not leak Cast listeners. */ }
    };
    const publish = () => {
      if (disposed) return;
      try {
        if (context.getCurrentSession() !== connectedSession || connectedSession.getMediaSession() !== receiver) {
          disconnect(); return;
        }
        const position = receiver.getEstimatedTime();
        const duration = receiver.media.duration;
        onProgress({
          positionSeconds: Number.isFinite(position) ? Math.max(0, position) : 0,
          ...(duration !== undefined && Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
          paused: receiver.playerState === 'PAUSED' || receiver.playerState === 'IDLE',
        });
      } catch { disconnect(); }
    };
    const update: MediaListener = (alive) => { if (alive) publish(); else disconnect(); };
    const sessionChanged: SessionListener = (event) => {
      if (event.session && event.session !== connectedSession) return;
      if (event.sessionState === 'SESSION_ENDED' || context.getCurrentSession() !== connectedSession) disconnect();
    };
    receiver.addUpdateListener(update);
    context.addEventListener(eventType, sessionChanged);
    timer = setInterval(publish, 1000);
    const command = (operation: (success: CastSuccess, failure: CastFailure) => void): Promise<void> => {
      if (disposed) return Promise.reject(castingError('This Cast connection has ended. Select Cast again.'));
      return new Promise<void>((resolve, reject) => {
        const failure = () => {
          disconnect();
          reject(castingError('The TV could not complete this playback command. Select Cast again.'));
        };
        try { operation(() => { publish(); resolve(); }, failure); }
        catch { failure(); }
      });
    };
    const deviceName = connectedSession.getCastDevice().friendlyName || 'Cast device';
    publish();
    if (disposed) throw castingError('The Cast connection ended before playback was ready.');
    return {
      deviceName,
      play: () => command((success, failure) => receiver.play(new sdk.api.media.PlayRequest(), success, failure)),
      pause: () => command((success, failure) => receiver.pause(new sdk.api.media.PauseRequest(), success, failure)),
      seek: (seconds) => {
        if (!Number.isFinite(seconds) || seconds < 0) return Promise.reject(castingError('Choose a valid playback position.'));
        return command((success, failure) => {
          const seek = new sdk.api.media.SeekRequest();
          const duration = receiver.media.duration;
          seek.currentTime = duration !== undefined && Number.isFinite(duration) && duration > 0 ? Math.min(seconds, duration) : seconds;
          receiver.seek(seek, success, failure);
        });
      },
      stop: () => {
        if (stopped || disconnected) return;
        stopped = true;
        publish();
        disconnect();
        cleanup();
        try { connectedSession.endSession(true); } catch { /* Local cleanup must succeed even when the device is gone. */ }
      },
      dispose: cleanup,
    };
  } catch {
    cleanup();
    try { session?.endSession(true); } catch { /* Clean up partially connected sessions after failed loads. */ }
    throw castingError('Casting could not connect or load this video. Check that the TV can access the video and select Cast again in desktop Chrome.');
  }
}
