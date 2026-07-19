import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { PEDESTRIAN_COLLISION_GROUPS } from '../core/const';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Ragdoll } from './Ragdoll';
import { CellRef, lanePoint, nextRoadCell } from '../world/RoadGraph';

const WALK_DIR = new THREE.Vector3();

export class Pedestrian implements Entity {
  readonly character: Character;
  dead = false;
  /** Time since death, for despawn. */
  deadFor = 0;
  private ragdoll: Ragdoll | null = null;
  private from: CellRef;
  private to: CellRef;
  private waypoint = { x: 0, z: 0 };
  private fleeDir: THREE.Vector3 | null = null;
  private fleeTime = 0;
  private impactCooldown = 0;
  private jitter: number;

  constructor(
    private game: Game,
    outfit: Outfit,
    heightScale: number,
    from: CellRef,
    to: CellRef
  ) {
    this.from = from;
    this.to = to;
    this.jitter = Math.random() * 0.08 - 0.04;
    this.waypoint = lanePoint(from, to, 0.4 + this.jitter);
    this.character = new Character(
      game,
      outfit,
      this.waypoint.x + (Math.random() - 0.5) * 2,
      this.waypoint.z + (Math.random() - 0.5) * 2,
      heightScale,
      PEDESTRIAN_COLLISION_GROUPS
    );
  }

  update(dt: number): void {
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    if (this.dead) {
      this.deadFor += dt;
      this.ragdoll?.update();
      return;
    }
    const pos = this.character.position();

    if (this.fleeDir) {
      this.fleeTime -= dt;
      this.character.setMove(this.fleeDir, true);
      this.character.update(dt);
      if (this.fleeTime <= 0) this.fleeDir = null;
      return;
    }

    // Scared of fast cars nearby.
    for (const v of this.game.vehicles) {
      const t = v.body.translation();
      const dx = pos.x - t.x;
      const dz = pos.z - t.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 49 && v.getSpeed() > 8) {
        this.fleeDir = new THREE.Vector3(dx, 0, dz).normalize();
        this.fleeTime = 2.2;
        break;
      }
    }

    const dist = Math.hypot(this.waypoint.x - pos.x, this.waypoint.z - pos.z);
    if (dist < 1.2) {
      const next = nextRoadCell(this.from, this.to, Math.random());
      this.from = this.to;
      this.to = next;
      this.waypoint = lanePoint(this.from, this.to, 0.4 + this.jitter);
    }
    WALK_DIR.set(this.waypoint.x - pos.x, 0, this.waypoint.z - pos.z).normalize();
    this.character.setMove(WALK_DIR, false);
    this.character.update(dt);
  }

  canReceiveVehicleImpact(): boolean {
    return !this.dead && this.impactCooldown <= 0;
  }

  /** Low-speed contact makes the pedestrian move away without a physics launch. */
  shove(direction: THREE.Vector3, strength: number): void {
    if (!this.canReceiveVehicleImpact()) return;
    this.impactCooldown = 0.35;
    this.fleeDir = direction.clone().setY(0);
    if (this.fleeDir.lengthSq() < 0.001) this.fleeDir.set(1, 0, 0);
    this.fleeDir.normalize();
    this.fleeTime = Math.max(this.fleeTime, 0.7 + Math.min(strength, 4) * 0.18);
  }

  /** Run over: hand the body to physics with the impact velocity. */
  die(impact: THREE.Vector3): void {
    if (this.dead) return;
    this.dead = true;
    this.impactCooldown = Infinity;
    // The ragdoll steals the rig's meshes before the character is disabled.
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
  }

  position(): THREE.Vector3 {
    return this.ragdoll ? this.ragdoll.position() : this.character.position();
  }

  dispose(): void {
    this.ragdoll?.dispose();
    this.character.dispose();
  }
}
