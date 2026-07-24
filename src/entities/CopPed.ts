import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Entity, Game } from '../core/Game';
import { PEDESTRIAN_COLLISION_GROUPS } from '../core/const';
import type { CombatTarget } from '../gameplay/Combat';
import { COP_HEALTH, GunDef, MeleeDef, WEAPONS, WeaponDef } from '../gameplay/Weapons';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import type { Player } from './Player';
import { Pickup } from './Pickup';
import { Ragdoll } from './Ragdoll';
import { buildWeaponMesh } from './WeaponMeshes';
import {
  findRoadRoute,
  nearestRoadPoint,
  pointWorld,
  roadPoints,
  type CellRef,
} from '../world/RoadGraph';

const COP_OUTFIT: Outfit = {
  skin: 0xe0ac69,
  hair: 0x241b17,
  shirt: 0x2b4a8f, // police blue
  pants: 0x161c30,
  shoes: 0x1c1c22,
};

/** Cop-grade pistol: slower, less accurate and less damaging than the player's. */
const COP_PISTOL: GunDef = {
  ...(WEAPONS.pistol as GunDef),
  damage: 8,
  spread: 0.03,
  fireInterval: 0.8,
};

const ENGAGE_MIN = 6;
const ENGAGE_MAX = 14;
const MELEE_RANGE = 1.6;
const DESPAWN_DIST = 110;

const DIR = new THREE.Vector3();

interface TackleTransition {
  elapsed: number;
  duration: number;
  startFeet: THREE.Vector3;
  endFeet: THREE.Vector3;
  currentFeet: THREE.Vector3;
  yaw: number;
}

/**
 * Armed on-foot officer deployed from a stopped police car at 2+ stars.
 * Pursues the wanted player, shoots at mid range, punches up close.
 */
export class CopPed implements Entity, CombatTarget {
  readonly character: Character;
  dead = false;
  deadFor = 0;
  /** Set when the player's heat clears; the cop disengages and walks off. */
  leaving = false;
  private leaveTimer = 0;
  private ragdoll: Ragdoll | null = null;
  private health: number;
  private pistol: GunDef;
  private fireCooldown = 1.2; // grace period after deploying
  private punchCooldown = 0;
  private pendingPunch = false;
  private tackle: TackleTransition | null = null;
  private pursuitRoute: CellRef[] = [];
  private pursuitRouteTimer = 0;

  constructor(
    private game: Game,
    private target: Player,
    x: number,
    z: number,
    responseLevel = 2
  ) {
    this.health = COP_HEALTH + Math.max(0, responseLevel - 2) * 30;
    this.pistol = {
      ...COP_PISTOL,
      damage: COP_PISTOL.damage + Math.max(0, responseLevel - 2) * 3,
      fireInterval: Math.max(0.58, COP_PISTOL.fireInterval - Math.max(0, responseLevel - 2) * 0.12),
    };
    this.character = new Character(game, COP_OUTFIT, x, z, 1, PEDESTRIAN_COLLISION_GROUPS);
    this.character.rig.setHeldItem(buildWeaponMesh('pistol'));
    game.combat.register(this.character.collider, this);
  }

  alive(): boolean {
    return !this.dead;
  }

  position(): THREE.Vector3 {
    return this.ragdoll
      ? this.ragdoll.position()
      : this.tackle?.currentFeet.clone() ?? this.character.position();
  }

  takeHit(damage: number, dir: THREE.Vector3, weapon: WeaponDef, attacker: Player | null): void {
    if (this.dead) return;
    this.health -= damage;
    if (this.health <= 0) {
      this.die(dir.clone().multiplyScalar(weapon.kind === 'melee' ? 3.5 + weapon.knockback : 6));
      // Killing an officer escalates hard, and their sidearm hits the street.
      this.game.reportCrime(attacker, 70, this.position(), false);
      return;
    }
    this.character.flinch();
    if (weapon.kind === 'melee') this.game.reportCrime(attacker, weapon.heatPerHit, this.position(), false);
  }

  private die(impact: THREE.Vector3): void {
    const pos = this.position();
    this.dead = true;
    this.tackle = null;
    this.health = 0;
    this.game.combat.unregister(this.character.collider);
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
    this.game.pickups.push(new Pickup(this.game, 'pistol', 12, pos.x, pos.y, pos.z));
  }

  /** Lunge into the target before the player's arrest ragdoll takes over. */
  beginTackle(targetFeet: THREE.Vector3, duration: number): void {
    if (this.dead || this.tackle) return;
    const startFeet = this.character.position();
    const direction = targetFeet.clone().sub(startFeet).setY(0);
    if (direction.lengthSq() < 0.01) direction.set(0, 0, 1);
    else direction.normalize();
    const endFeet = targetFeet.clone().addScaledVector(direction, -0.62);
    const yaw = Math.atan2(direction.x, direction.z);
    this.pendingPunch = false;
    this.character.rig.setHeldItem(null);
    this.character.setFacing(yaw);
    this.character.beginScriptedPose();
    this.tackle = {
      elapsed: 0,
      duration: Math.max(0.1, duration),
      startFeet,
      endFeet,
      currentFeet: startFeet.clone(),
      yaw,
    };
    this.updateTackle(0);
  }

  private updateTackle(dt: number): void {
    const tackle = this.tackle;
    if (!tackle) return;
    tackle.elapsed = Math.min(tackle.duration, tackle.elapsed + dt);
    const progress = tackle.elapsed / tackle.duration;
    const lunge = THREE.MathUtils.smootherstep(progress, 0.02, 0.58);
    tackle.currentFeet.lerpVectors(tackle.startFeet, tackle.endFeet, lunge);
    this.character.setTacklePose(tackle.currentFeet, tackle.yaw, progress, 'attacker');
    if (progress < 1) return;
    this.character.finishScriptedPose(tackle.endFeet, tackle.yaw);
    this.tackle = null;
  }

  update(dt: number): void {
    if (this.dead) {
      this.deadFor += dt;
      this.ragdoll?.update();
      return;
    }
    if (this.tackle) {
      this.updateTackle(dt);
      return;
    }
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);

    const pos = this.character.position();
    const targetPos = this.target.wanted.pursuitTarget();
    DIR.set(targetPos.x - pos.x, 0, targetPos.z - pos.z);
    const dist = DIR.length();

    if (this.leaving || this.target.dead || this.target.driving) {
      // Walk away from the action until despawned.
      this.leaveTimer += dt;
      this.character.setAimPose('none');
      if (dist < 30 && dist > 0.1) {
        this.character.setMove(DIR.clone().multiplyScalar(-1 / dist), false);
      } else {
        this.character.setMove(new THREE.Vector3(), false);
      }
      this.character.update(dt);
      return;
    }

    if (this.target.wanted.searching) {
      // Search the frozen last-known position without firing or swinging at
      // an empty point. A later sighting clears `searching` and resumes combat.
      this.pendingPunch = false;
      this.character.setAimPose('none');
      this.character.setMove(dist > 1.2
        ? this.pursuitDirection(pos, targetPos, dt)
        : new THREE.Vector3(), false);
      this.character.update(dt);
      return;
    }

    // Resolve a queued punch at the swing's contact frame.
    if (this.pendingPunch) {
      const t = this.character.actionProgress();
      if (t === null || t >= 0.4) {
        const hits = this.game.combat.meleeSweep(
          WEAPONS.fists as MeleeDef,
          pos,
          this.character.getFacing(),
          null,
          this
        );
        if (hits > 0) this.game.audio.thwack(dist);
        this.pendingPunch = false;
      }
    }

    const yawToTarget = Math.atan2(DIR.x, DIR.z);
    if (dist < MELEE_RANGE + 0.2) {
      // Point blank: holster-free brawling.
      this.character.setAimPose('none');
      this.character.overrideFacing(yawToTarget);
      this.character.setMove(new THREE.Vector3(), false);
      if (this.punchCooldown <= 0 && this.character.startAction('punch', 0.5)) {
        this.punchCooldown = 1.1;
        this.pendingPunch = true;
      }
    } else if (dist <= ENGAGE_MAX && this.lineOfSight(pos, targetPos)) {
      // Stop and shoot.
      this.character.overrideFacing(yawToTarget);
      this.character.setAimPose('pistol');
      if (dist < ENGAGE_MIN) {
        // Back up a little while keeping the gun on target.
        this.character.setMove(DIR.clone().multiplyScalar(-1 / dist), false);
      } else {
        this.character.setMove(new THREE.Vector3(), false);
      }
      if (this.fireCooldown <= 0) {
        this.fireCooldown = this.pistol.fireInterval;
        const muzzle = new THREE.Vector3(
          pos.x + Math.sin(yawToTarget) * 0.45,
          pos.y + 1.35,
          pos.z + Math.cos(yawToTarget) * 0.45
        );
        const aim = new THREE.Vector3(
          targetPos.x - muzzle.x,
          targetPos.y + 1.2 - muzzle.y,
          targetPos.z - muzzle.z
        ).normalize();
        this.game.combat.fireHitscan(this.pistol, muzzle, aim, null, this.character.collider);
        this.game.audio.gunshot('pistol', dist);
      }
    } else {
      // Chase directly across open ground, or use the pedestrian graph when
      // fixed geometry blocks the target. This avoids treating a wall as a
      // permanent steering target.
      this.character.setAimPose('none');
      this.character.setMove(this.pursuitDirection(pos, targetPos, dt), true);
    }
    this.character.update(dt);
  }

  private pursuitDirection(
    position: THREE.Vector3,
    target: THREE.Vector3,
    dt: number
  ): THREE.Vector3 {
    const direct = new THREE.Vector3(target.x - position.x, 0, target.z - position.z);
    if (direct.lengthSq() <= 0.01) return direct.set(0, 0, 0);
    if (this.character.hasClearPathTo(target)) {
      this.pursuitRoute = [];
      this.pursuitRouteTimer = 0;
      return direct.normalize();
    }

    this.pursuitRouteTimer -= dt;
    if (this.pursuitRouteTimer <= 0 || this.pursuitRoute.length === 0) {
      this.replanPursuit(position, target);
    }
    while (this.pursuitRoute.length > 0) {
      const waypoint = pointWorld(this.pursuitRoute[0]);
      if (Math.hypot(waypoint.x - position.x, waypoint.z - position.z) > 1.05) break;
      this.pursuitRoute.shift();
    }
    const next = this.pursuitRoute[0];
    if (!next) return direct.set(0, 0, 0);
    const waypoint = pointWorld(next);
    if (!this.character.hasClearPathTo(waypoint, 0.2)) {
      this.pursuitRoute = [];
      this.pursuitRouteTimer = 0;
      return direct.set(0, 0, 0);
    }
    return direct.set(waypoint.x - position.x, 0, waypoint.z - position.z).normalize();
  }

  private replanPursuit(position: THREE.Vector3, target: THREE.Vector3): void {
    this.pursuitRouteTimer = 0.65;
    this.pursuitRoute = [];
    const start = this.nearestReachablePedestrianPoint(position);
    const goal = nearestRoadPoint(target.x, target.z, 'pedestrian');
    if (!start || !goal) return;
    const route = findRoadRoute(start, goal, 'pedestrian', { maxVisited: 2500 });
    if (route) this.pursuitRoute = route;
  }

  /**
   * The geometrically nearest footpath can be on the far side of the same
   * building. Prefer a slightly farther node that the capsule can actually
   * reach from its current side.
   */
  private nearestReachablePedestrianPoint(position: THREE.Vector3): CellRef | null {
    const nearest = nearestRoadPoint(position.x, position.z, 'pedestrian');
    if (nearest) {
      const waypoint = pointWorld(nearest);
      if (this.character.hasClearPathTo(waypoint, 0.2)) return nearest;
    }
    const candidates = roadPoints('pedestrian')
      .map((point) => {
        const waypoint = pointWorld(point);
        return {
          point,
          waypoint,
          distance: Math.hypot(waypoint.x - position.x, waypoint.z - position.z),
        };
      })
      .filter((candidate) => candidate.distance <= 18)
      .sort((left, right) =>
        left.distance - right.distance ||
        left.waypoint.z - right.waypoint.z ||
        left.waypoint.x - right.waypoint.x
      );
    return candidates.find((candidate) =>
      this.character.hasClearPathTo(candidate.waypoint, 0.2)
    )?.point ?? null;
  }

  private lineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const d = new THREE.Vector3(to.x - from.x, to.y + 1.2 - (from.y + 1.35), to.z - from.z);
    const len = d.length();
    if (len < 0.1) return true;
    d.divideScalar(len);
    const ray = new RAPIER.Ray(
      new RAPIER.Vector3(from.x, from.y + 1.35, from.z),
      new RAPIER.Vector3(d.x, d.y, d.z)
    );
    const hit = this.game.world.castRay(
      ray,
      len,
      true,
      undefined,
      undefined,
      this.character.collider,
      this.character.body
    );
    if (!hit) return true;
    return hit.collider.handle === this.target.character.collider.handle;
  }

  shouldDespawn(): boolean {
    const pos = this.position();
    const p = this.target.position();
    const dist = Math.hypot(p.x - pos.x, p.z - pos.z);
    return this.deadFor > 8 || dist > DESPAWN_DIST || (this.leaving && (this.leaveTimer > 10 || dist > 45));
  }

  dispose(): void {
    this.game.combat.unregister(this.character.collider);
    this.ragdoll?.dispose();
    this.character.dispose();
  }
}
