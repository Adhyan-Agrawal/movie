import { forwardRef, useEffect } from 'react';

function record(kind, value) {
  if (typeof window !== 'undefined' && window.__playerFixture) {
    window.__playerFixture[kind].push(value);
  }
}

const router = {
  push: (href) => record('navigation', { kind: 'push', href }),
  replace: (href) => record('navigation', { kind: 'replace', href }),
  refresh: () => record('navigation', { kind: 'refresh' }),
  prefetch: () => {},
};

export function useRouter() { return router; }

export const FixtureLink = forwardRef(function FixtureLink(
  { href, children, prefetch, replace, scroll, onClick, ...props }, ref,
) {
  if (typeof href !== 'string') throw new Error('Fixture links require a string href');
  return <a {...props} ref={ref} href={href} onClick={(event) => {
    onClick?.(event);
    const canceled = event.defaultPrevented;
    event.preventDefault();
    if (!canceled) router.push(href);
  }}>{children}</a>;
});

export function FixtureScript() { return null; }

function action(name) {
  return async (...args) => {
    record('actions', { name, args });
    return { ok: true, sessionId: 'private-fixture-session' };
  };
}

export const reportPlaybackStartAction = action('start');
export const reportPlaybackHeartbeatAction = action('heartbeat');
export const reportPlaybackEndAction = action('end');
export const reportPlaybackIssueAction = action('issue');
export const reportProgressAction = action('progress');

export class WatchPartyTransport {
  constructor(callbacks) {
    this.callbacks = callbacks;
    record('transports', this);
  }
  start(request) {
    record('transportRequests', { action: request.action });
    this.callbacks.onStatus({ phase: 'ticketing' });
  }
  setResumeToken() {}
  send(message) { record('transportMessages', message); return true; }
  retry() { this.callbacks.onStatus({ phase: 'ticketing' }); }
  disconnect() {}
}

// This boundary preserves NativePlayer's entire initial two-DIV DOM contract.
// The other fixture mode imports and executes the real NativePlayer as well.
export function NativeDomStub(props) {
  if (typeof window !== 'undefined' && window.__playerFixture) {
    window.__playerFixture.nativeProps = {
      autoNext: props.autoNext,
      navigation: props.episodeNavigation,
      disabled: props.episodeNavigationDisabled,
    };
  }
  useEffect(() => { props.onReady?.(); }, [props.onReady]);
  return <div className="lumora-player-frame relative h-full w-full bg-black">
    <div data-vjs-player="" className="h-full w-full" onContextMenu={(event) => event.preventDefault()} />
  </div>;
}

function emitter() {
  const listeners = new Map();
  return {
    on(events, listener) {
      for (const event of Array.isArray(events) ? events : [events]) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(listener);
      }
    },
    off(events, listener) {
      for (const event of Array.isArray(events) ? events : [events]) {
        listeners.get(event)?.delete(listener);
      }
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener({ type: event });
    },
  };
}

export function createVideoPlayer(element, options) {
  const events = emitter();
  const quality = Object.assign([], emitter(), { selectedIndex: -1 });
  const audio = Object.assign([], emitter());
  const text = Object.assign([], emitter());
  const video = document.createElement('video');
  video.playsInline = true;
  element.appendChild(video);
  const state = { disposed: false, position: 0, paused: true, rate: 1, volume: 1,
    muted: false, fullscreen: false, pip: false, source: options.sources[0].src };
  const later = (event) => queueMicrotask(() => { if (!state.disposed) events.emit(event); });
  const player = {
    fixtureState: state,
    el: () => element,
    isDisposed: () => state.disposed,
    dispose: () => { state.disposed = true; video.remove(); },
    on: events.on,
    off: events.off,
    trigger: events.emit,
    ready: (callback) => queueMicrotask(callback),
    qualityLevels: () => quality,
    audioTracks: () => audio,
    textTracks: () => text,
    remoteTextTracks: () => text,
    readyState: () => 4,
    error: () => null,
    seeking: () => false,
    ended: () => state.position >= 120,
    duration: () => 120,
    paused: () => state.paused,
    currentTime(value) {
      if (value !== undefined) { state.position = value; later('seeked'); }
      return state.position;
    },
    playbackRate(value) {
      if (value !== undefined && value !== state.rate) { state.rate = value; later('ratechange'); }
      return state.rate;
    },
    volume(value) { if (value !== undefined) state.volume = value; return state.volume; },
    muted(value) { if (value !== undefined) state.muted = value; return state.muted; },
    controls: () => true,
    userActive: () => true,
    play() { state.paused = false; later('playing'); return Promise.resolve(); },
    pause() { if (!state.paused) { state.paused = true; later('pause'); } },
    src(value) {
      if (value) { state.source = value.src; later('loadedmetadata'); later('loadeddata'); }
      return state.source;
    },
    currentSrc: () => state.source,
    isFullscreen: () => state.fullscreen,
    requestFullscreen() { state.fullscreen = true; later('fullscreenchange'); return Promise.resolve(); },
    exitFullscreen() { state.fullscreen = false; later('fullscreenchange'); },
    isInPictureInPicture(value) { if (value !== undefined) state.pip = value; return state.pip; },
    disablePictureInPicture: () => false,
    requestPictureInPicture: () => Promise.resolve(),
    exitPictureInPicture: () => Promise.resolve(),
    addRemoteTextTrack(configuration) {
      const target = new EventTarget();
      target.track = { ...configuration, mode: 'disabled', cues: [], addCue() {}, removeCue() {} };
      return target;
    },
    removeRemoteTextTrack: () => {},
  };
  record('players', player);
  later('loadeddata');
  later('canplay');
  return player;
}
