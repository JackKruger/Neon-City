import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import type { PlayerInput } from '../core/Input';
import type { CameraTarget } from '../render/Viewports';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Vehicle } from './Vehicle';
import { Wanted } from '../gameplay/Wanted';
import { heightAt } from '../world/CityMap';

const ENTER_RADIUS = 3.5;

const P1_OUTFIT: Outfit = {
  skin: 0xe0ac69,
  hair: 0x241b17,
  shirt: 0x29c5f6, // cyan jacket
  pants: 0x2b2d42,
  shoes: 0xf5f5f5,
};
const P2_OUTFIT: Outfit = {
  skin: 0xc68642,
  hair: 0x1a1a2e,
  shirt: 0xff5f9e, // magenta jacket
  pants: 0x14213d,
  shoes: 0x22223b,
};

export class Player implements Entity, CameraTarget {
  readonly character: Character;
  readonly wanted: Wanted;
  vehicle: Vehicle | null = null;
  /** Set each fixed step by Game before update(). */
  input: PlayerInput | null = null;
  /** Camera view yaw, for camera-relative on-foot movement. */
  cameraYaw = 0;
  prompt: string | null = null;
  private balance = 0;

  constructor(
    private game: Game,
    readonly index: 0 | 1,
    x: number,
    z: number
  ) {
    this.character = new Character(game, index === 0 ? P1_OUTFIT : P2_OUTFIT, x, z);
    this.wanted = new Wanted(game, this);
  }

  get driving(): boolean {
    return this.vehicle !== null;
  }

  get money(): number {
    return this.balance;
  }

  /** Credit whole dollars to this player. */
  earnMoney(amount: number): void {
    const dollars = Math.floor(amount);
    if (!Number.isFinite(amount) || dollars <= 0) {
      throw new RangeError('Money earned must be a positive finite amount');
    }
    this.balance += dollars;
  }

  /** Debit whole dollars if the player can afford the purchase. */
  spendMoney(amount: number): boolean {
    const dollars = Math.floor(amount);
    if (!Number.isFinite(amount) || dollars <= 0) {
      throw new RangeError('Money spent must be a positive finite amount');
    }
    if (dollars > this.balance) return false;
    this.balance -= dollars;
    return true;
  }

  update(dt: number): void {
    this.wanted.update(dt);
    const input = this.input;
    this.prompt = null;
    if (!input) return;

    if (this.vehicle) {
      this.vehicle.command = {
        steer: input.steer,
        throttle: input.throttle,
        brake: input.brake,
        handbrake: input.handbrake,
      };
      if (input.interact) this.exitVehicle();
      return;
    }

    const mag = Math.min(1, Math.hypot(input.moveX, input.moveY));
    if (mag > 0.05) {
      const yaw = this.cameraYaw;
      const fwd = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const right = new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw));
      const dir = fwd
        .multiplyScalar(input.moveY)
        .addScaledVector(right, input.moveX)
        .normalize();
      this.character.setMove(dir, input.sprint);
    } else {
      this.character.setMove(new THREE.Vector3(), false);
    }
    if (input.jump) this.character.jump();
    this.character.update(dt);

    const nearest = this.nearestVehicle();
    if (nearest) {
      this.prompt = 'E / Y — steal car';
      if (input.interact) this.enterVehicle(nearest);
    }
  }

  private nearestVehicle(): Vehicle | null {
    const pos = this.character.position();
    let best: Vehicle | null = null;
    let bestDist = ENTER_RADIUS;
    for (const v of this.game.vehicles) {
      if (v.driver) continue;
      const t = v.body.translation();
      const d = Math.hypot(t.x - pos.x, t.z - pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  enterVehicle(v: Vehicle): void {
    v.driver = this;
    this.vehicle = v;
    this.character.setEnabled(false);
  }

  exitVehicle(): void {
    const v = this.vehicle;
    if (!v) return;
    const t = v.body.translation();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(v.quaternion());
    // Handbrake only: `brake` acts as reverse throttle once nearly stopped,
    // which would make the abandoned car creep backwards.
    v.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
    v.driver = null;
    this.vehicle = null;
    const ex = t.x + right.x * 2.4;
    const ez = t.z + right.z * 2.4;
    this.character.teleport(ex, Math.max(t.y, heightAt(ex, ez) + 0.1), ez);
    this.character.setEnabled(true);
  }

  // CameraTarget
  getFocus(out: THREE.Vector3): void {
    if (this.vehicle) {
      this.vehicle.getFocus(out);
    } else {
      out.copy(this.character.position());
      out.y += 0.9;
    }
  }
  getHeading(): number {
    return this.vehicle ? this.vehicle.getHeading() : this.character.getFacing();
  }
  getSpeed(): number {
    return this.vehicle ? this.vehicle.getSpeed() : 0;
  }
  getFollowDistance(): number {
    return this.vehicle ? 7 : 4.2;
  }
}
