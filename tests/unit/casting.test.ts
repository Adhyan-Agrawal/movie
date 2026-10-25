import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastingHandle, CastingMedia } from '@/features/player/casting';

const MEDIA: CastingMedia = {
  url: '/api/vidnest?token=opaque-capability', contentType: 'application/x-mpegURL',
  title: 'Example movie', posterUrl: '/poster.jpg', positionSeconds: 12.5, autoplay: false,
};
type ProgressCallback = (progress: { positionSeconds: number; durationSeconds?: number; paused: boolean }) => void;
type AvailabilityCallback = (available: boolean) => void;
type SessionEvent = { sessionState: string; session?: unknown };

function fakeSdk() {
  const mediaListeners = new Set<(alive: boolean) => void>();
  const sessionListeners = new Set<(event: SessionEvent) => void>();
  const receiver = {
    media: { duration: 120 }, playerState: 'PLAYING', position: 12.5,
    getEstimatedTime: vi.fn(() => receiver.position),
    addUpdateListener: vi.fn((listener: (alive: boolean) => void) => { mediaListeners.add(listener); }),
    removeUpdateListener: vi.fn((listener: (alive: boolean) => void) => { mediaListeners.delete(listener); }),
    play: vi.fn((_request: object, success: () => void) => { receiver.playerState = 'PLAYING'; success(); }),
    pause: vi.fn((_request: object, success: () => void) => { receiver.playerState = 'PAUSED'; success(); }),
    seek: vi.fn((request: { currentTime: number }, success: () => void) => { receiver.position = request.currentTime; success(); }),
  };
  const session = {
    loadMedia: vi.fn(async (_request: object) => undefined),
    getMediaSession: vi.fn(() => receiver),
    getCastDevice: vi.fn(() => ({ friendlyName: 'Living room TV' })),
    endSession: vi.fn(),
  };
  const context = {
    setOptions: vi.fn(), requestSession: vi.fn(async () => undefined),
    getCurrentSession: vi.fn(() => session),
    addEventListener: vi.fn((_type: string, listener: (event: SessionEvent) => void) => { sessionListeners.add(listener); }),
    removeEventListener: vi.fn((_type: string, listener: (event: SessionEvent) => void) => { sessionListeners.delete(listener); }),
  };
  class MediaInfo { constructor(public contentId: string, public contentType: string) {} }
  class LoadRequest { currentTime = 0; autoplay = true; constructor(public media: MediaInfo) {} }
  class GenericMediaMetadata {}
  class PlayRequest {}
  class PauseRequest {}
  class SeekRequest { currentTime = 0 }
  return {
    receiver, session, context, mediaListeners, sessionListeners,
    chrome: { cast: { isAvailable: true, AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' }, media: {
      MediaInfo, LoadRequest, GenericMediaMetadata, PlayRequest, PauseRequest, SeekRequest,
    } } },
    cast: { framework: { CastContext: { getInstance: () => context }, CastContextEventType: { SESSION_STATE_CHANGED: 'session_state_changed' } } },
  };
}

let sdk: ReturnType<typeof fakeSdk>;
let target: {
  location: { href: string };
  navigator: { userAgent: string };
  chrome?: ReturnType<typeof fakeSdk>['chrome'];
  cast?: ReturnType<typeof fakeSdk>['cast'];
  __onGCastApiAvailable?: AvailabilityCallback;
};
let scripts: Array<{ src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null; remove: ReturnType<typeof vi.fn> }>;
let video: HTMLVideoElement;
let requestCasting: typeof import('@/features/player/casting')['requestCasting'];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  sdk = fakeSdk();
  target = { location: { href: 'https://movies.example.com/watch/example' }, navigator: { userAgent: 'Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36' } };
  scripts = [];
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', {
    createElement: vi.fn(() => ({ src: '', async: false, onload: null, onerror: null, remove: vi.fn() })),
    head: { appendChild: vi.fn((script: typeof scripts[number]) => { scripts.push(script); }) },
  });
  video = { currentSrc: 'blob:https://movies.example.com/mse', play: vi.fn(), pause: vi.fn() } as unknown as HTMLVideoElement;
  ({ requestCasting } = await import('@/features/player/casting'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installSdk() { target.chrome = sdk.chrome; target.cast = sdk.cast; }
async function connect(onProgress: ProgressCallback = vi.fn(), onDisconnect = vi.fn()): Promise<CastingHandle> {
  installSdk();
  return (await requestCasting(video, MEDIA, onProgress, onDisconnect))!;
}

describe('native casting', () => {
  it('opens AirPlay synchronously without claiming a connection or loading an SDK', async () => {
    const picker = vi.fn();
    Object.assign(video, { webkitShowPlaybackTargetPicker: picker });
    const onProgress = vi.fn();
    const onDisconnect = vi.fn();
    expect(await requestCasting(video, { ...MEDIA, url: 'blob:local' }, onProgress, onDisconnect)).toBeNull();
    expect(picker).toHaveBeenCalledOnce();
    expect(scripts).toHaveLength(0);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('uses supported RemotePlayback directly and leaves its timeline browser-owned', async () => {
    const prompt = vi.fn(async () => undefined);
    Object.assign(video, { remote: { prompt } });
    expect(await requestCasting(video, MEDIA, vi.fn(), vi.fn())).toBeNull();
    expect(prompt).toHaveBeenCalledOnce();
    expect(scripts).toHaveLength(0);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('falls back to Google for unsupported native media but not a dismissed picker', async () => {
    Object.assign(video, { remote: { prompt: vi.fn(async () => { throw { name: 'NotSupportedError' }; }) } });
    const handle = await connect();
    expect(handle.deviceName).toBe('Living room TV');
    handle.dispose();
    Object.assign(video, { remote: { prompt: vi.fn(async () => { throw { name: 'AbortError', message: 'https://secret:credential@example.com' }; }) } });
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('device picker');
    expect(sdk.context.requestSession).toHaveBeenCalledOnce();
  });
});

describe('Google Cast URL guard', () => {
  it.each([
    'blob:https://movies.example.com/video', 'data:video/mp4;base64,AAA', 'file:///video.mp4',
    'http://public.example.com/video.mp4', 'https://localhost/video', 'https://localhost./video',
    'https://tv.local/video', 'https://server/video', 'https://foo.internal/video',
    'https://127.0.0.1/video', 'https://2130706433/video', 'https://10.1.2.3/video',
    'https://192.168.1.2/video', 'https://172.20.1.2/video', 'https://169.254.1.2/video',
    'https://100.64.1.2/video', 'https://[::1]/video', 'https://[fc00::1]/video',
    'https://user:password@public.example.com/video', 'https://224.0.0.1/video',
  ])('rejects non-public or credentialed URL %s before network or a picker', async (url) => {
    await expect(requestCasting(video, { ...MEDIA, url }, vi.fn(), vi.fn())).rejects.toMatchObject({ name: 'CastingError' });
    expect(scripts).toHaveLength(0);
    expect(sdk.context.requestSession).not.toHaveBeenCalled();
  });

  it('rejects relative localhost media and sanitizes invalid URL errors', async () => {
    target.location.href = 'http://localhost:3100/watch';
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('public HTTPS');
    await expect(requestCasting(video, { ...MEDIA, url: 'https://[malformed-secret' }, vi.fn(), vi.fn())).rejects.toThrow('playable Cast URL');
    expect(scripts).toHaveLength(0);
  });

  it('loads the absolute original capability URL, position and autoplay, never the MSE currentSrc or credentials', async () => {
    const handle = await connect();
    expect(sdk.context.setOptions).toHaveBeenCalledWith({ receiverApplicationId: 'CC1AD845', autoJoinPolicy: 'origin_scoped' });
    expect(sdk.session.loadMedia).toHaveBeenCalledWith({
      media: {
        contentId: 'https://movies.example.com/api/vidnest?token=opaque-capability', contentType: 'application/x-mpegURL',
        metadata: { title: 'Example movie', images: [{ url: 'https://movies.example.com/poster.jpg' }] },
      },
      currentTime: 12.5, autoplay: false,
    });
    expect(video.pause).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('omits inaccessible or credentialed artwork without failing the video', async () => {
    installSdk();
    const handle = await requestCasting(video, { ...MEDIA, posterUrl: 'https://user:password@images.example.com/poster' }, vi.fn(), vi.fn());
    expect(sdk.session.loadMedia.mock.calls[0]?.[0]).toMatchObject({ media: { metadata: { title: MEDIA.title } } });
    expect(JSON.stringify(sdk.session.loadMedia.mock.calls)).not.toContain('password');
    handle?.dispose();
  });

  it('rejects unsupported browsers and invalid start positions without loading scripts', async () => {
    target.navigator.userAgent = 'Safari/605.1';
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('desktop Chrome');
    target.navigator.userAgent = 'Chrome/130.0';
    for (const positionSeconds of [NaN, Infinity, -1]) {
      await expect(requestCasting(video, { ...MEDIA, positionSeconds }, vi.fn(), vi.fn())).rejects.toThrow('not ready');
    }
    expect(scripts).toHaveLength(0);
  });
});

describe('lazy SDK loading', () => {
  it('single-flights concurrent loads and removes script hooks, timer and global callback after readiness', async () => {
    const previous = vi.fn();
    target.__onGCastApiAvailable = previous;
    const first = requestCasting(video, MEDIA, vi.fn(), vi.fn());
    const second = requestCasting(video, MEDIA, vi.fn(), vi.fn());
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.src).toBe('https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1');
    expect(scripts[0]?.async).toBe(true);
    installSdk();
    target.__onGCastApiAvailable?.(true);
    const handles = await Promise.all([first, second]);
    expect(previous).toHaveBeenCalledWith(true);
    expect(target.__onGCastApiAvailable).toBe(previous);
    expect(scripts[0]?.onload).toBeNull();
    expect(scripts[0]?.onerror).toBeNull();
    expect(scripts[0]?.remove).toHaveBeenCalledOnce();
    handles.forEach((handle) => handle?.dispose());
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['error', 'unavailable', 'timeout'])('cleans failed %s loads and permits a later retry', async (failure) => {
    const pending = requestCasting(video, MEDIA, vi.fn(), vi.fn());
    const result = expect(pending).rejects.toThrow('Google Cast could not start');
    if (failure === 'error') scripts[0]?.onerror?.();
    if (failure === 'unavailable') target.__onGCastApiAvailable?.(false);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
    expect(target.__onGCastApiAvailable).toBeUndefined();
    expect(scripts[0]?.remove).toHaveBeenCalledOnce();
    const retry = requestCasting(video, MEDIA, vi.fn(), vi.fn());
    expect(scripts).toHaveLength(2);
    installSdk();
    target.__onGCastApiAvailable?.(true);
    (await retry)?.dispose();
  });
});

describe('remote playback and cleanup', () => {
  it('polls estimated receiver time every second and also publishes media updates', async () => {
    const onProgress = vi.fn();
    const handle = await connect(onProgress);
    expect(onProgress).toHaveBeenLastCalledWith({ positionSeconds: 12.5, durationSeconds: 120, paused: false });
    sdk.receiver.position = 45.75;
    sdk.receiver.playerState = 'PAUSED';
    await vi.advanceTimersByTimeAsync(1000);
    expect(onProgress).toHaveBeenLastCalledWith({ positionSeconds: 45.75, durationSeconds: 120, paused: true });
    sdk.receiver.position = 46;
    sdk.mediaListeners.forEach((listener) => listener(true));
    expect(onProgress).toHaveBeenLastCalledWith({ positionSeconds: 46, durationSeconds: 120, paused: true });
    sdk.receiver.media.duration = NaN;
    sdk.receiver.position = -5;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onProgress).toHaveBeenLastCalledWith({ positionSeconds: 0, paused: true });
    handle.dispose();
  });

  it('forwards play/pause/seek commands, clamps seek, and ends casting only on explicit stop', async () => {
    const onDisconnect = vi.fn();
    const handle = await connect(vi.fn(), onDisconnect);
    await handle.pause();
    expect(sdk.receiver.pause).toHaveBeenCalledOnce();
    expect(sdk.receiver.playerState).toBe('PAUSED');
    await handle.play();
    expect(sdk.receiver.play).toHaveBeenCalledOnce();
    await handle.seek(45.5);
    expect(sdk.receiver.position).toBe(45.5);
    await handle.seek(999);
    expect(sdk.receiver.position).toBe(120);
    await expect(handle.seek(NaN)).rejects.toThrow('valid playback position');
    await expect(handle.seek(-1)).rejects.toThrow('valid playback position');
    handle.stop();
    handle.stop();
    expect(sdk.session.endSession).toHaveBeenCalledOnce();
    expect(sdk.session.endSession).toHaveBeenCalledWith(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(handle.play()).rejects.toThrow('connection has ended');
  });

  it('dispose removes all observers without stopping the TV or notifying disconnect', async () => {
    const onProgress = vi.fn();
    const onDisconnect = vi.fn();
    const handle = await connect(onProgress, onDisconnect);
    handle.dispose();
    handle.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(sdk.session.endSession).not.toHaveBeenCalled();
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['media', 'session', 'poll'])('detects %s disconnection and removes all callbacks exactly once', async (event) => {
    const onDisconnect = vi.fn();
    const handle = await connect(vi.fn(), onDisconnect);
    if (event === 'media') sdk.mediaListeners.forEach((listener) => listener(false));
    if (event === 'session') sdk.sessionListeners.forEach((listener) => listener({ sessionState: 'SESSION_ENDED', session: sdk.session }));
    if (event === 'poll') {
      sdk.receiver.getEstimatedTime.mockImplementation(() => { throw new Error('unavailable'); });
      await vi.advanceTimersByTimeAsync(1000);
    }
    handle.dispose();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(sdk.session.endSession).not.toHaveBeenCalled();
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans partial listener setup failures and ends a session whose media load fails', async () => {
    installSdk();
    sdk.session.loadMedia.mockRejectedValueOnce(new Error('https://user:password@private.example.com'));
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('Casting could not connect');
    expect(sdk.session.endSession).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
    sdk.context.addEventListener.mockImplementationOnce(() => { throw new Error('listener failed'); });
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('Casting could not connect');
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes picker rejection and does not end a session the user did not select', async () => {
    installSdk();
    sdk.context.requestSession.mockRejectedValueOnce(new Error('https://user:password@private.example.com'));
    await expect(requestCasting(video, MEDIA, vi.fn(), vi.fn())).rejects.toThrow('Casting could not connect');
    expect(sdk.session.endSession).not.toHaveBeenCalled();
    expect(sdk.session.loadMedia).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans listeners and polling when a remote playback command throws', async () => {
    const onDisconnect = vi.fn();
    const handle = await connect(vi.fn(), onDisconnect);
    sdk.receiver.pause.mockImplementationOnce(() => { throw new Error('https://user:password@private.example.com'); });
    await expect(handle.pause()).rejects.toThrow('could not complete');
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(sdk.session.endSession).not.toHaveBeenCalled();
  });

  it('cleans a failed progress callback even if disconnect callbacks also throw', async () => {
    installSdk();
    await expect(requestCasting(video, MEDIA, () => { throw new Error('UI failed'); }, () => { throw new Error('UI failed again'); })).rejects.toThrow('Casting could not connect');
    expect(sdk.mediaListeners.size).toBe(0);
    expect(sdk.sessionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(sdk.session.endSession).toHaveBeenCalledWith(true);
  });
});
