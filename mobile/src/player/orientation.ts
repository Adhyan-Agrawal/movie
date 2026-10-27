import * as ScreenOrientation from 'expo-screen-orientation';

const leases: Array<{ token: object; lock: ScreenOrientation.OrientationLock }> = [];
let original: ScreenOrientation.PlatformOrientationInfo | null = null;
let queue: Promise<void> = Promise.resolve();

/** Nested player/fullscreen leases restore the original OS policy regardless of React cleanup order. */
export function acquireOrientation(lock: ScreenOrientation.OrientationLock, onError?: () => void): () => void {
  const token = {};
  leases.push({ token, lock });
  function apply() {
    queue = queue.then(async () => {
      original ??= await ScreenOrientation.getPlatformOrientationLockAsync();
      const active = leases[leases.length - 1];
      if (active) await ScreenOrientation.lockAsync(active.lock);
      else {
        await ScreenOrientation.lockPlatformAsync(original);
        original = null;
      }
    }).catch(() => onError?.());
  }
  apply();
  return () => {
    const index = leases.findIndex((lease) => lease.token === token);
    if (index < 0) return;
    leases.splice(index, 1);
    apply();
  };
}
