export interface PlayerOrientation {
  lock?: (orientation: 'landscape') => Promise<void>;
  unlock?: () => void;
}

const owners = new WeakMap<PlayerOrientation, object>();

export function createFullscreenOrientation(orientation?: PlayerOrientation) {
  const owner = {};
  let generation = 0;
  let wanted = false;
  let locked = false;
  let pending = false;
  let disposed = false;

  const release = () => {
    if (!orientation || (owners.has(orientation) && owners.get(orientation) !== owner)) return;
    try { orientation.unlock?.(); } catch { /* Browser orientation support is optional. */ }
    if (owners.get(orientation) === owner) owners.delete(orientation);
    locked = false;
  };

  return {
    async setFullscreen(fullscreen: boolean): Promise<void> {
      if (disposed || !orientation || typeof orientation.lock !== 'function') return;
      if (fullscreen && wanted && (pending || locked)) return;
      wanted = fullscreen;
      const request = ++generation;
      if (!fullscreen) {
        if (pending || locked) release();
        pending = false;
        return;
      }
      owners.set(orientation, owner);
      pending = true;
      try {
        await orientation.lock('landscape');
        if (request === generation && wanted && !disposed) locked = true;
        else if (!wanted || disposed) release();
      } catch {
        // iOS and browsers without orientation permission still retain working fullscreen.
        if (orientation && owners.get(orientation) === owner) owners.delete(orientation);
      } finally {
        if (request === generation) pending = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      wanted = false;
      generation += 1;
      if (pending || locked) release();
      pending = false;
    },
  };
}
