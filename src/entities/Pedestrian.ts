import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { Character } from './Character';
import { CellRef, lanePoint, nextRoadCell } from '../world/RoadGraph';

const WALK_DIR = new THREE.Vector3();

export class Pedestrian implements Entity {
  readonly character: Character;
  dead = false;
  /** Time since death, for despawn. */
  deadFor = 0;
  private from: CellRef;
  private to: CellRef;
  private waypoint = { x: 0, z: 0 };
  private fleeDir: THREE.Vector3 | null = null;
  private fleeTime = 0;
  private jitter: number;

  constructor(
    private game: Game,
    model: string,
    from: CellRef,
    to: CellRef
  ) {
    this.from = from;
    this.to = to;
    this.jitter = Math.random() * 0.08 - 0.04;
    this.waypoint = lanePoint(from, to, 0.4 + this.jitter);
    this.character = new Character(
      game,
      model,
      this.waypoint.x + (Math.random() - 0.5) * 2,
      this.waypoint.z + (Math.random() - 0.5) * 2
    );
  }

  update(dt: number): void {
    if (this.dead) {
      this.deadFor += dt;
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

  /** Run over: flop the model and stop simulating. */
  die(): void {
    if (this.dead) return;
    this.dead = true;
    this.character.setEnabled(false);
    // Leave the body visible, lying on the ground.
    this.character.root.visible = true;
    const pos = this.character.position();
    this.character.root.position.set(pos.x, 0.35, pos.z);
    this.character.root.rotation.x = -Math.PI / 2;
  }

  position(): THREE.Vector3 {
    return this.character.position();
  }

  dispose(): void {
    this.character.dispose();
  }
}
