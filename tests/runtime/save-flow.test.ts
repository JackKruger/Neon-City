import { describe, expect, it, vi } from 'vitest';
import { restoreAtomically, SaveController } from '../../src/save/SaveController';

describe('save flow', () => {
  it('autosaves each 60 active seconds and retains unsafe elapsed time', () => {
    let safe = true;
    const save = vi.fn();
    const controller = new SaveController(() => safe, save);
    controller.update(59);
    expect(save).not.toHaveBeenCalled();
    safe = false;
    controller.update(1);
    controller.update(12);
    expect(save).not.toHaveBeenCalled();
    expect(controller.pendingSeconds).toBe(72);
    safe = true;
    controller.update(0.1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(controller.pendingSeconds).toBeCloseTo(12.1);
  });

  it('only saves on pagehide when safe', () => {
    let safe = false;
    const save = vi.fn();
    const controller = new SaveController(() => safe, save);
    expect(controller.saveForPageHide()).toBe(false);
    safe = true;
    expect(controller.saveForPageHide()).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it('does not apply a save when prewarming fails', async () => {
    const apply = vi.fn();
    const result = await restoreAtomically(
      () => ({ ok: true as const, value: { x: 1 } }),
      async () => { throw new Error('missing chunk'); },
      apply
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'prewarm' } });
    expect(apply).not.toHaveBeenCalled();
  });
});
