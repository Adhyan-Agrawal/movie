import { describe, expect, it, vi } from 'vitest';
import { createFullscreenOrientation } from '@/features/player/fullscreen-orientation';

describe('player fullscreen orientation', () => {
  it('locks landscape once and restores automatic orientation after exit', async () => {
    const orientation = { lock: vi.fn(async () => {}), unlock: vi.fn() };
    const controller = createFullscreenOrientation(orientation);
    await controller.setFullscreen(true);
    await controller.setFullscreen(true);
    expect(orientation.lock).toHaveBeenCalledOnce();
    expect(orientation.lock).toHaveBeenCalledWith('landscape');
    await controller.setFullscreen(false);
    expect(orientation.unlock).toHaveBeenCalledOnce();
    controller.dispose();
    expect(orientation.unlock).toHaveBeenCalledOnce();
  });

  it('handles missing and rejected browser support without rejecting fullscreen', async () => {
    await expect(createFullscreenOrientation().setFullscreen(true)).resolves.toBeUndefined();
    const controller = createFullscreenOrientation({ lock: async () => { throw new Error('Unsupported'); } });
    await expect(controller.setFullscreen(true)).resolves.toBeUndefined();
    controller.dispose();
  });

  it('releases a late orientation lock after fullscreen has already exited', async () => {
    let resolve!: () => void;
    const orientation = { lock: vi.fn(() => new Promise<void>((done) => { resolve = done; })), unlock: vi.fn() };
    const controller = createFullscreenOrientation(orientation);
    const pending = controller.setFullscreen(true);
    await controller.setFullscreen(false);
    resolve();
    await pending;
    expect(orientation.unlock).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('does not release another player orientation lock when an old request finishes', async () => {
    let resolve!: () => void;
    const orientation = { lock: vi.fn()
      .mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }))
      .mockResolvedValue(undefined), unlock: vi.fn() };
    const first = createFullscreenOrientation(orientation);
    const pending = first.setFullscreen(true);
    first.dispose();
    const second = createFullscreenOrientation(orientation);
    await second.setFullscreen(true);
    const calls = orientation.unlock.mock.calls.length;
    resolve();
    await pending;
    expect(orientation.unlock).toHaveBeenCalledTimes(calls);
    second.dispose();
    expect(orientation.unlock).toHaveBeenCalledTimes(calls + 1);
  });
});
