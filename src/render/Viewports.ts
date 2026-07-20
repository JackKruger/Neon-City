import * as THREE from 'three';
import type { CameraInput } from '../core/Input';
import { heightAt } from '../world/CityMap';

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

const BASE_FOV = 65;
type CollisionResolver = (
  target: CameraTarget,
  focus: THREE.Vector3,
  desired: THREE.Vector3,
  out: THREE.Vector3
) => void;

function angleDelta(next: number, previous: number): number {
  let delta = next - previous;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private position = new THREE.Vector3();
  private focusSmooth = new THREE.Vector3();
  private initialized = false;
  private tmpFocus = new THREE.Vector3();
  private tmpIdeal = new THREE.Vector3();
  private tmpResolved = new THREE.Vector3();
  private fov = BASE_FOV;
  private controlYaw = 0;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private recentering = false;
  private lastTargetHeading: number | null = null;
  private manualOrbitGrace = 0;

  constructor(aspect: number, private resolveCollision?: CollisionResolver) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.3, 340);
  }

  update(
    target: CameraTarget,
    dt: number,
    look: CameraInput,
    reducedMotion: boolean,
    followHeading = true,
    settleBehind = false
  ): void {
    if (look.recenter) this.recentering = true;
    const manualLook = Math.abs(look.yaw) > 0.0001 || Math.abs(look.pitch) > 0.0001;
    if (manualLook) {
      this.recentering = false;
      this.manualOrbitGrace = 0.9;
    } else {
      this.manualOrbitGrace = Math.max(0, this.manualOrbitGrace - dt);
    }
    const targetHeading = target.getHeading();
    if (this.lastTargetHeading !== null && !followHeading && !this.recentering) {
      // On foot, turning the character must not also rotate the movement basis.
      // Preserve the current world-space chase heading until the player or
      // recenter control explicitly changes it.
      this.orbitYaw -= angleDelta(targetHeading, this.lastTargetHeading);
    }
    this.lastTargetHeading = targetHeading;
    this.orbitYaw += look.yaw;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + look.pitch, -0.22, 0.78);
    if (this.recentering) {
      const k = 1 - Math.exp(-6 * dt);
      this.orbitYaw *= 1 - k;
      this.orbitPitch *= 1 - k;
      if (Math.abs(this.orbitYaw) + Math.abs(this.orbitPitch) < 0.002) {
        this.orbitYaw = 0;
        this.orbitPitch = 0;
        this.recentering = false;
      }
    } else if (settleBehind && this.manualOrbitGrace <= 0) {
      // On foot, gradually swing behind the character as their facing changes.
      // This is deliberately gentler than the explicit V/R3 recenter above.
      const k = 1 - Math.exp(-1.8 * dt);
      this.orbitYaw *= 1 - k;
      if (Math.abs(this.orbitYaw) < 0.002) this.orbitYaw = 0;
    }
    target.getFocus(this.tmpFocus);
    const heading = targetHeading + this.orbitYaw;
    this.controlYaw = heading;
    const base = target.getFollowDistance();
    const dist = base + Math.min(target.getSpeed() * 0.12, 4);
    const height = base * 0.45 + this.orbitPitch * dist;

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

    this.position.y = Math.max(this.position.y, heightAt(this.position.x, this.position.z) + 1.2);
    if (this.resolveCollision) {
      this.tmpResolved.copy(this.focusSmooth);
      this.tmpResolved.y += 1.15;
      this.resolveCollision(target, this.tmpResolved, this.position, this.position);
    }

    // Widen the FOV with speed for a sense of rush.
    const targetFov = reducedMotion ? BASE_FOV : BASE_FOV + Math.min(target.getSpeed() * 0.35, 11);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-3 * dt));
    if (Math.abs(this.fov - this.camera.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.camera.position.copy(this.position);
    this.camera.lookAt(
      this.focusSmooth.x,
      this.focusSmooth.y + 1.4,
      this.focusSmooth.z
    );
  }

  /** Intended chase yaw, kept stable through positional follow smoothing. */
  yaw(): number {
    return this.controlYaw;
  }
}

/** Owns the single active chase camera and full-canvas viewport. */
export class Viewports {
  readonly cameras: ChaseCamera[];

  constructor(private renderer: THREE.WebGLRenderer, private resolveCollision?: CollisionResolver) {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.cameras = [new ChaseCamera(size.x / size.y, this.resolveCollision)];
  }

  updateAspects(): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.cameras[0].camera.aspect = size.x / size.y;
    this.cameras[0].camera.updateProjectionMatrix();
  }

  render(scene: THREE.Scene): void {
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.info.reset();
    this.renderer.render(scene, this.cameras[0].camera);
  }
}
