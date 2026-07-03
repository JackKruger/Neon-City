import * as THREE from 'three';

export interface CameraTarget {
  /** World position to follow. */
  getFocus(out: THREE.Vector3): void;
  /** Yaw (radians) the camera should settle behind. */
  getHeading(): number;
  /** Extra follow distance for fast targets (e.g. car speed). */
  getSpeed(): number;
  /** Base follow distance (m). */
  getFollowDistance(): number;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private position = new THREE.Vector3();
  private focusSmooth = new THREE.Vector3();
  private initialized = false;
  private tmpFocus = new THREE.Vector3();
  private tmpIdeal = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(65, aspect, 0.3, 700);
  }

  update(target: CameraTarget, dt: number): void {
    target.getFocus(this.tmpFocus);
    const heading = target.getHeading();
    const base = target.getFollowDistance();
    const dist = base + Math.min(target.getSpeed() * 0.12, 4);
    const height = base * 0.45;

    // Sit behind the target: heading is the direction (sin h, 0, cos h).
    this.tmpIdeal.set(
      this.tmpFocus.x - Math.sin(heading) * dist,
      this.tmpFocus.y + height,
      this.tmpFocus.z - Math.cos(heading) * dist
    );

    if (!this.initialized) {
      this.position.copy(this.tmpIdeal);
      this.focusSmooth.copy(this.tmpFocus);
      this.initialized = true;
    } else {
      const posK = 1 - Math.exp(-5 * dt);
      const focusK = 1 - Math.exp(-12 * dt);
      this.position.lerp(this.tmpIdeal, posK);
      this.focusSmooth.lerp(this.tmpFocus, focusK);
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(
      this.focusSmooth.x,
      this.focusSmooth.y + 1.4,
      this.focusSmooth.z
    );
  }

  /** Current view yaw (camera toward focus), for camera-relative input. */
  yaw(): number {
    return Math.atan2(
      this.focusSmooth.x - this.position.x,
      this.focusSmooth.z - this.position.z
    );
  }
}

/** Renders one or two viewports with scissor-test split screen. */
export class Viewports {
  readonly cameras: ChaseCamera[] = [];

  constructor(private renderer: THREE.WebGLRenderer) {
    this.renderer.setScissorTest(true);
  }

  setPlayerCount(count: 1 | 2): void {
    while (this.cameras.length < count) {
      this.cameras.push(new ChaseCamera(this.aspectFor(count)));
    }
    this.cameras.length = count;
    this.updateAspects();
  }

  private aspectFor(count: number): number {
    const size = this.renderer.getSize(new THREE.Vector2());
    return count === 2 ? size.x / 2 / size.y : size.x / size.y;
  }

  updateAspects(): void {
    const aspect = this.aspectFor(this.cameras.length);
    for (const c of this.cameras) {
      c.camera.aspect = aspect;
      c.camera.updateProjectionMatrix();
    }
  }

  render(scene: THREE.Scene): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    const n = this.cameras.length;
    for (let i = 0; i < n; i++) {
      const w = n === 2 ? Math.floor(size.x / 2) : size.x;
      const x = i === 0 ? 0 : size.x - w;
      this.renderer.setViewport(x, 0, w, size.y);
      this.renderer.setScissor(x, 0, w, size.y);
      this.renderer.render(scene, this.cameras[i].camera);
    }
  }
}
