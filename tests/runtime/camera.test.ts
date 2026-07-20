import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ChaseCamera, type CameraTarget } from '../../src/render/Viewports';

class TestTarget implements CameraTarget {
  heading = 0;

  getFocus(out: THREE.Vector3): void {
    out.set(0, 1, 0);
  }

  getHeading(): number {
    return this.heading;
  }

  getSpeed(): number {
    return 0;
  }

  getFollowDistance(): number {
    return 5;
  }
}

describe('on-foot chase camera', () => {
  it('smoothly settles behind a character after they turn', () => {
    const camera = new ChaseCamera(16 / 9);
    const target = new TestTarget();
    const idleLook = { yaw: 0, pitch: 0, recenter: false };
    camera.update(target, 1 / 60, idleLook, false, false, false);

    target.heading = Math.PI / 2;
    camera.update(target, 1 / 60, idleLook, false, false, false);
    expect(camera.yaw()).toBeCloseTo(0, 5);

    camera.update(target, 1 / 60, idleLook, false, false, true);
    expect(camera.yaw()).toBeGreaterThan(0);
    expect(camera.yaw()).toBeLessThan(target.heading);

    for (let i = 0; i < 180; i++) {
      camera.update(target, 1 / 60, idleLook, false, false, true);
    }
    expect(Math.abs(camera.yaw() - target.heading)).toBeLessThan(0.01);
  });
});
