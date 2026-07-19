import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Entity } from '../core/Game';
import type { CameraTarget } from '../render/Viewports';

export interface DriveCommand {
  steer: number; // -1..1
  throttle: number; // 0..1
  brake: number; // 0..1, reverse/backward near zero speed
  handbrake: boolean; // car handbrake; helicopter ascend
  descend?: boolean; // helicopter descent (Shift)
}

/** Shared surface used by players, cameras, NPC impacts, cars, and aircraft. */
export interface Drivable extends Entity, CameraTarget {
  readonly kind: 'car' | 'helicopter';
  readonly root: THREE.Group;
  readonly body: RAPIER.RigidBody;
  command: DriveCommand;
  driver: object | null;
  destroyed: boolean;

  forwardSpeed(): number;
  forward(): THREE.Vector3;
  quaternion(): THREE.Quaternion;
  speedKmh(): number;
  overlapsPedestrian(position: THREE.Vector3, radius?: number, height?: number): boolean;
  doorPosition(side: 1 | -1, clearance: number, out?: THREE.Vector3): THREE.Vector3;
  seatPosition(side: 1 | -1, out?: THREE.Vector3): THREE.Vector3;
  setDoorOpen(side: 1 | -1, open: boolean): void;
  canExit(): boolean;
  afterPhysics(): void;
  dispose(): void;
}
