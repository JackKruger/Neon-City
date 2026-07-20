import * as THREE from 'three';
import type { Game } from '../core/Game';
import type { Player } from '../entities/Player';
import { CopPed } from '../entities/CopPed';
import { PoliceCar } from '../entities/PoliceCar';
import { pointWorld, randomRoadCellNear } from '../world/RoadGraph';

const STAR_THRESHOLDS = [25, 55, 100];
const SIGHT_RADIUS = 42;
const SEARCH_TIME = 18;
const MAX_HEAT = 130;
const RESPONSE_CARS = [0, 2, 3, 5];

export class Wanted {
  heat = 0;
  stars = 0;
  private unseenTimer = 0;
  private searchTimer = 0;
  private arrestTimer = 0;
  private spawnCooldown = 0;
  private lastKnown = new THREE.Vector3();
  searching = false;
  private lockedStars: 0 | 1 | 2 | 3 | null = null;
  readonly police: PoliceCar[] = [];
  readonly copPeds: CopPed[] = [];

  constructor(
    private game: Game,
    private player: Player
  ) {}

  addHeat(amount: number, origin?: THREE.Vector3): void {
    if (this.lockedStars === 0) return;
    this.heat = Math.min(this.heat + amount, MAX_HEAT);
    this.unseenTimer = 0;
    this.searchTimer = 0;
    this.searching = false;
    this.lastKnown.copy(origin ?? this.player.position());
    this.recomputeStars();
  }

  get policeAware(): boolean {
    return this.stars > 0 || this.police.some((police) => !police.leaving) ||
      this.copPeds.some((cop) => !cop.leaving && !cop.dead);
  }

  /** Pursuers aim for the frozen last-known point while the player is hidden. */
  pursuitTarget(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.searching) return out.copy(this.lastKnown);
    const target = this.player.driving ? this.player.vehicle!.root.position : this.player.position();
    return out.copy(target);
  }

  /** Drop all heat immediately (player death/arrest). Police disengage. */
  clear(): void {
    this.heat = 0;
    this.searching = false;
    this.searchTimer = 0;
    this.unseenTimer = 0;
    this.arrestTimer = 0;
    this.recomputeStars();
  }

  get lockedLevel(): 0 | 1 | 2 | 3 | null {
    return this.lockedStars;
  }

  /** Hold a deterministic response level for testing, or null for normal heat. */
  setLockedLevel(stars: 0 | 1 | 2 | 3 | null): void {
    this.lockedStars = stars;
    if (stars === null) return;
    this.heat = stars === 0 ? 0 : STAR_THRESHOLDS[stars - 1];
    this.unseenTimer = 0;
    this.searchTimer = 0;
    this.searching = false;
    this.recomputeStars();
  }

  /** Immediately dispose every responder and reset all pursuit/search timers. */
  reset(): void {
    for (const cop of this.copPeds) cop.dispose();
    for (const police of this.police) police.dispose();
    this.copPeds.length = 0;
    this.police.length = 0;
    this.spawnCooldown = 0;
    this.lastKnown.set(0, 0, 0);
    this.clear();
  }

  private recomputeStars(): void {
    let s = 0;
    for (const t of STAR_THRESHOLDS) if (this.heat >= t) s++;
    this.stars = s;
  }

  update(dt: number): void {
    if (this.lockedStars !== null && this.stars !== this.lockedStars) {
      this.heat = this.lockedStars === 0 ? 0 : STAR_THRESHOLDS[this.lockedStars - 1];
      this.recomputeStars();
    }
    for (const p of this.police) p.update(dt);

    // Line-of-sight is approximated by a conservative awareness radius. Once
    // contact breaks, units search the last known position instead of tracking
    // the player through the city.
    if (this.stars > 0) {
      const nearestCar = Math.min(...this.police.filter((p) => !p.leaving).map((p) => p.distanceToTarget()), Infinity);
      const playerPos = this.player.position();
      let nearestFootCop: CopPed | null = null;
      let nearestFoot = Infinity;
      for (const cop of this.copPeds.filter((candidate) => !candidate.dead && !candidate.leaving)) {
        const p = cop.position();
        const distance = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
        if (distance >= nearestFoot) continue;
        nearestFoot = distance;
        nearestFootCop = cop;
      }
      if (Math.min(nearestCar, nearestFoot) <= SIGHT_RADIUS) {
        this.lastKnown.copy(this.player.driving ? this.player.vehicle!.root.position : playerPos);
        this.unseenTimer = 0;
        this.searchTimer = 0;
        this.searching = false;
      } else {
        this.unseenTimer += dt;
        if (this.unseenTimer > 2) {
          this.searching = true;
          this.searchTimer += dt;
        }
        if (this.searchTimer > SEARCH_TIME && this.lockedStars === null) {
          this.heat = 0;
          this.recomputeStars();
        }
      }

      const arrestDistance = Math.min(nearestFoot, this.player.driving ? Infinity : nearestCar);
      if (!this.player.driving && arrestDistance < 2.4) {
        this.arrestTimer += dt;
        if (this.arrestTimer > 1.35) {
          const fine = 50 + this.stars * 75;
          this.player.bust(fine, nearestFoot <= nearestCar ? nearestFootCop : null);
          return;
        }
      } else this.arrestTimer = 0;
    }

    // Keep police population in line with the star count.
    const want = RESPONSE_CARS[this.stars] ?? 0;
    const active = this.police.filter((p) => !p.leaving).length;
    this.spawnCooldown -= dt;
    if (active < want && this.spawnCooldown <= 0) {
      this.spawnCooldown = 2.5;
      this.spawnPolice(active >= 3 && this.stars >= 3);
    }
    if (want === 0) {
      for (const p of this.police) p.leaving = true;
      for (const c of this.copPeds) c.leaving = true;
    }
    for (let i = this.police.length - 1; i >= 0; i--) {
      if (this.police[i].shouldDespawn()) {
        this.police[i].dispose();
        this.police.splice(i, 1);
      }
    }
    for (const c of this.copPeds) c.update(dt);
    for (let i = this.copPeds.length - 1; i >= 0; i--) {
      if (this.copPeds[i].shouldDespawn()) {
        const gone = this.copPeds[i];
        // Free the car to deploy a replacement officer later.
        for (const car of this.police) if (car.deployedCop === gone) car.deployedCop = null;
        gone.dispose();
        this.copPeds.splice(i, 1);
      }
    }
  }

  /**
   * Called by a stopped pursuing police car: at 2+ stars an officer steps out
   * to engage an on-foot target. One deployment per car; capped at star count.
   */
  maybeDeployCop(car: PoliceCar): void {
    if (this.stars < 2 || this.player.driving || this.player.dead || this.searching) return;
    if (car.deployedCop && !car.deployedCop.dead) return;
    const active = this.copPeds.filter((c) => !c.dead && !c.leaving).length;
    if (active >= this.stars) return;
    const t = car.vehicle.body.translation();
    const right = new THREE.Vector3(1.6, 0, 0).applyQuaternion(car.vehicle.quaternion());
    const cop = new CopPed(this.game, this.player, t.x + right.x, t.z + right.z, this.stars);
    car.deployedCop = cop;
    this.copPeds.push(cop);
  }

  private spawnPolice(roadblock: boolean): void {
    const pos = this.player.driving
      ? this.player.vehicle!.root.position
      : this.player.position();
    for (let tries = 0; tries < 14; tries++) {
      const cell = randomRoadCellNear(pos.x, pos.z, 55, 105);
      if (!cell) continue;
      // Compiled navigation nodes carry exact lane coordinates. Falling back
      // to the containing tile centre can put responders on the wrong deck of
      // a bridge, beside the road, or inside nearby scenery.
      const { x, z } = pointWorld(cell);
      const heading = Math.atan2(pos.x - x, pos.z - z) + (roadblock ? Math.PI / 2 : 0);
      if (!this.game.vehicleSpawnIsClear(x, z, heading)) continue;
      this.police.push(new PoliceCar(this.game, this.player, x, z, heading, roadblock));
      return;
    }
  }
}
