import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { PEDESTRIAN_COLLISION_GROUPS, TILE } from '../core/const';
import type { CombatTarget } from '../gameplay/Combat';
import type { Player } from './Player';
import { MeleeDef, PED_HEALTH, WEAPONS, WeaponDef } from '../gameplay/Weapons';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Ragdoll } from './Ragdoll';
import { CellRef, lanePoint, nextRoadCell, pointWorld } from '../world/RoadGraph';
import { Vehicle } from './Vehicle';
import type { TrafficCar } from './TrafficCar';

const WALK_DIR = new THREE.Vector3();
const NPC_ENTER_TIME = 0.95;
const NPC_EXIT_TIME = 0.8;

interface NpcVehicleTransition {
  kind: 'enter' | 'exit';
  vehicle: Vehicle;
  owner: TrafficCar | null;
  side: 1 | -1;
  phase: 'approach' | 'animate';
  elapsed: number;
  startFeet: THREE.Vector3;
  startYaw: number;
}

function ease(t: number): number {
  return THREE.MathUtils.smootherstep(THREE.MathUtils.clamp(t, 0, 1), 0, 1);
}

function lerpYaw(from: number, to: number, t: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * t;
}

export class Pedestrian implements Entity, CombatTarget {
  character: Character;
  dead = false;
  health = PED_HEALTH;
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
  /** Brave peds fight back instead of fleeing when attacked. */
  private readonly brave: boolean;
  private brawlTarget: Player | null = null;
  private brawlTime = 0;
  private punchCooldown = 0;
  private pendingPunch = false;
  private knockedDown = false;
  private knockdownTimer = 0;
  private vehicleTransition: NpcVehicleTransition | null = null;

  constructor(
    private game: Game,
    private readonly outfit: Outfit,
    private readonly heightScale: number,
    from: CellRef,
    to: CellRef,
    spawn?: { x: number; z: number }
  ) {
    this.from = from;
    this.to = to;
    this.brave = Math.random() < game.pedBraveChance;
    this.jitter = Math.random() * 0.08 - 0.04;
    this.waypoint = this.laneWaypoint();
    const x = spawn?.x ?? this.waypoint.x + (Math.random() - 0.5) * 2;
    const z = spawn?.z ?? this.waypoint.z + (Math.random() - 0.5) * 2;
    this.character = new Character(
      game,
      outfit,
      x,
      z,
      heightScale,
      PEDESTRIAN_COLLISION_GROUPS
    );
    game.combat.register(this.character.collider, this);
  }

  alive(): boolean {
    return !this.dead;
  }

  get profile(): { outfit: Outfit; heightScale: number } {
    return { outfit: this.outfit, heightScale: this.heightScale };
  }

  /** Weapon damage from players (and later cops/brawlers). */
  takeHit(damage: number, dir: THREE.Vector3, weapon: WeaponDef, attacker: Player | null): void {
    if (this.dead || this.knockedDown) return;
    this.health -= damage;
    if (this.health <= 0) {
      const strength = weapon.kind === 'melee' ? 3.5 + weapon.knockback : 6;
      this.die(dir.clone().multiplyScalar(strength));
      this.game.reportCrime(attacker, 40);
      return;
    }
    this.character.flinch();
    if (this.brave && attacker) {
      this.brawlTarget = attacker;
      this.brawlTime = 0;
    } else {
      this.shove(dir, weapon.kind === 'melee' ? weapon.knockback : 1.5);
    }
    if (weapon.kind === 'melee') this.game.reportCrime(attacker, weapon.heatPerHit);
  }

  update(dt: number): void {
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    if (this.dead) {
      this.deadFor += dt;
      this.ragdoll?.update();
      return;
    }
    if (this.knockedDown) {
      this.ragdoll?.update();
      this.knockdownTimer -= dt;
      if (this.knockdownTimer <= 0) this.standUp();
      return;
    }
    if (this.vehicleTransition) {
      this.updateVehicleTransition(dt);
      return;
    }
    const pos = this.character.position();

    if (this.brawlTarget) {
      this.updateBrawl(dt, pos);
      return;
    }

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
      const next = nextRoadCell(this.from, this.to, Math.random(), 'pedestrian');
      this.from = this.to;
      this.to = next;
      this.waypoint = this.laneWaypoint();
    }
    WALK_DIR.set(this.waypoint.x - pos.x, 0, this.waypoint.z - pos.z).normalize();
    this.character.setMove(this.shouldYieldToTraffic(pos, WALK_DIR) ? new THREE.Vector3() : WALK_DIR, false);
    this.character.update(dt);
  }

  /** Pause when a moving vehicle's short prediction crosses this footpath. */
  private shouldYieldToTraffic(pos: THREE.Vector3, direction: THREE.Vector3): boolean {
    const futureX = pos.x + direction.x * 1.8;
    const futureZ = pos.z + direction.z * 1.8;
    for (const vehicle of this.game.vehicles) {
      const velocity = vehicle.body.linvel();
      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed < 1.5) continue;
      const t = vehicle.body.translation();
      const predictedX = t.x + velocity.x * 0.55;
      const predictedZ = t.z + velocity.z * 0.55;
      if (Math.hypot(predictedX - futureX, predictedZ - futureZ) < 3.2) return true;
    }
    return false;
  }

  /** Reserve an abandoned car once this pedestrian reaches its driver door. */
  tryEnterVehicle(vehicle: Vehicle): boolean {
    if (this.dead || this.knockedDown || this.vehicleTransition || this.brawlTarget || this.fleeDir) return false;
    if (vehicle.driver || vehicle.destroyed || vehicle.burning || vehicle.getSpeed() > 0.8) return false;
    const pos = this.character.position();
    const t = vehicle.body.translation();
    const local = pos.clone().sub(new THREE.Vector3(t.x, t.y, t.z)).applyQuaternion(vehicle.quaternion().invert());
    this.vehicleTransition = {
      kind: 'enter',
      vehicle,
      owner: null,
      side: local.x >= 0 ? 1 : -1,
      phase: 'approach',
      elapsed: 0,
      startFeet: pos,
      startYaw: this.character.getFacing(),
    };
    return true;
  }

  /** Materialize a traffic driver in the seat and animate them out safely. */
  beginVehicleExit(vehicle: Vehicle, owner: TrafficCar, side: 1 | -1): void {
    if (this.dead || this.knockedDown || this.vehicleTransition) return;
    this.vehicleTransition = {
      kind: 'exit',
      vehicle,
      owner,
      side,
      phase: 'animate',
      elapsed: 0,
      startFeet: vehicle.seatPosition(side),
      startYaw: vehicle.getHeading(),
    };
    vehicle.setDoorOpen(side, true);
    this.character.beginVehicleTransition(false);
  }

  private updateVehicleTransition(dt: number): void {
    const transition = this.vehicleTransition!;
    const vehicle = transition.vehicle;
    const side = transition.side;
    if (vehicle.destroyed) {
      this.cancelVehicleTransition(true);
      return;
    }

    if (transition.phase === 'approach') {
      if (vehicle.driver !== null || vehicle.burning || vehicle.getSpeed() > 1.2) {
        this.cancelVehicleTransition(false);
        return;
      }
      const pos = this.character.position();
      const outside = vehicle.doorPosition(side, 1.05);
      const dx = outside.x - pos.x;
      const dz = outside.z - pos.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 0.05) this.character.setMove(new THREE.Vector3(dx / distance, 0, dz / distance), false);
      this.character.update(dt);
      if (distance > 1.15) return;
      vehicle.driver = this; // claim the seat before the doorway animation starts
      vehicle.command = { steer: 0, throttle: 0, brake: 0, handbrake: true };
      vehicle.setDoorOpen(side, true);
      transition.phase = 'animate';
      transition.elapsed = 0;
      transition.startFeet.copy(this.character.position());
      transition.startYaw = this.character.getFacing();
      this.character.beginVehicleTransition(true);
      this.game.audio.carDoor(this.distanceToPlayers(vehicle));
      return;
    }

    if (transition.kind === 'exit' && vehicle.driver !== transition.owner) {
      this.cancelVehicleTransition(false);
      return;
    }
    transition.elapsed += dt;
    const duration = transition.kind === 'enter' ? NPC_ENTER_TIME : NPC_EXIT_TIME;
    const p = Math.min(1, transition.elapsed / duration);
    const seat = vehicle.seatPosition(side);
    const doorway = vehicle.doorPosition(side, 0.18);
    const outside = vehicle.doorPosition(side, 1.05);
    const t = vehicle.body.translation();
    const inwardYaw = Math.atan2(t.x - outside.x, t.z - outside.z);
    const feet = new THREE.Vector3();
    let seatBlend = 0;
    let visible = true;
    let yaw = inwardYaw;

    if (transition.kind === 'enter') {
      if (p < 0.42) feet.lerpVectors(transition.startFeet, outside, ease(p / 0.42));
      else if (p < 0.72) feet.lerpVectors(outside, doorway, ease((p - 0.42) / 0.3));
      else feet.lerpVectors(doorway, seat, ease((p - 0.72) / 0.28));
      seatBlend = ease((p - 0.42) / 0.58);
      yaw = lerpYaw(transition.startYaw, inwardYaw, ease(p / 0.4));
      visible = p < 0.92;
    } else {
      if (p < 0.38) feet.lerpVectors(seat, doorway, ease(p / 0.38));
      else feet.lerpVectors(doorway, outside, ease((p - 0.38) / 0.62));
      seatBlend = 1 - ease(p / 0.82);
      visible = p > 0.08;
    }
    this.character.setVehicleTransitionPose(feet, yaw, seatBlend, side, visible);
    if (p < 1) return;

    vehicle.setDoorOpen(side, false);
    this.game.audio.carDoor(this.distanceToPlayers(vehicle));
    this.vehicleTransition = null;
    if (transition.kind === 'enter') {
      this.game.npcs.completePedestrianVehicleEntry(this, vehicle);
      return;
    }
    if (vehicle.driver === transition.owner) vehicle.driver = null;
    this.game.npcs.completeTrafficDriverExit(vehicle, this);
    this.character.teleport(outside.x, outside.y, outside.z);
    this.character.setFacing(inwardYaw);
    this.character.setEnabled(true);
    this.fleeDir = vehicle.forward().multiplyScalar(-1);
    this.fleeTime = 2.5;
  }

  private cancelVehicleTransition(forceAway: boolean): void {
    const transition = this.vehicleTransition;
    if (!transition) return;
    const outside = transition.vehicle.doorPosition(transition.side, forceAway ? 1.7 : 1.05);
    if (transition.vehicle.driver === this) transition.vehicle.driver = null;
    transition.vehicle.setDoorOpen(transition.side, false);
    this.vehicleTransition = null;
    if (!this.character.enabled) {
      this.character.teleport(outside.x, outside.y, outside.z);
      this.character.setEnabled(true);
    }
  }

  /** Release a streamed vehicle while its body is still available for a safe fallback pose. */
  cancelVehicleTransitionForRemoval(vehicle: Vehicle): void {
    if (this.vehicleTransition?.vehicle === vehicle) this.cancelVehicleTransition(false);
  }

  private distanceToPlayers(vehicle: Vehicle): number {
    const t = vehicle.body.translation();
    return Math.min(...this.game.playerPositions().map((player) =>
      Math.hypot(player.x - t.x, player.z - t.z)
    ));
  }

  /** Recover if the road graph unloads between entering the seat and AI handoff. */
  restoreAfterFailedVehicleEntry(vehicle: Vehicle): void {
    const position = this.character.position();
    const t = vehicle.body.translation();
    const local = position.clone()
      .sub(new THREE.Vector3(t.x, t.y, t.z))
      .applyQuaternion(vehicle.quaternion().invert());
    const outside = vehicle.doorPosition(local.x >= 0 ? 1 : -1, 1.1);
    this.character.teleport(outside.x, outside.y, outside.z);
    this.character.setEnabled(true);
    this.fleeDir = vehicle.forward().multiplyScalar(-1);
    this.fleeTime = 2;
  }

  /** Witnesses flee the scene and make the crime reportable. */
  reactToCrime(origin: THREE.Vector3): void {
    if (this.dead || this.knockedDown) return;
    if (this.vehicleTransition?.phase === 'approach') this.cancelVehicleTransition(false);
    if (this.vehicleTransition) return;
    const pos = this.character.position();
    this.fleeDir = pos.clone().sub(origin).setY(0);
    if (this.fleeDir.lengthSq() < 0.01) this.fleeDir.set(1, 0, 0);
    this.fleeDir.normalize();
    this.fleeTime = Math.max(this.fleeTime, 4.5);
    this.brawlTarget = null;
    this.pendingPunch = false;
  }

  availableForVehicle(): boolean {
    return !this.dead && !this.knockedDown && !this.vehicleTransition && !this.brawlTarget && !this.fleeDir;
  }

  /** Footpath target with a small perpendicular offset so pedestrians spread
   *  across the path instead of tracking its centreline single-file. */
  private laneWaypoint(): { x: number; z: number } {
    const base = lanePoint(this.from, this.to, 0.4 + this.jitter);
    // Grid maps bake the sidewalk + jitter offset into lanePoint; the compiled
    // network returns the exact footpath node, so apply the spread here.
    if (this.to.x === undefined) return base;
    const a = pointWorld(this.from);
    const b = pointWorld(this.to);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    const offset = this.jitter * TILE;
    return { x: base.x + (-dz / length) * offset, z: base.z + (dx / length) * offset };
  }

  /** Chase the attacker and throw punches until they get away (or worse). */
  private updateBrawl(dt: number, pos: THREE.Vector3): void {
    const target = this.brawlTarget!;
    this.brawlTime += dt;
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);
    const targetPos = target.position();
    const dx = targetPos.x - pos.x;
    const dz = targetPos.z - pos.z;
    const dist = Math.hypot(dx, dz);

    if (target.dead || target.driving || dist > 25 || this.brawlTime > 15) {
      this.brawlTarget = null;
      this.pendingPunch = false;
      // Adrenaline spent; run from the scene like everyone else.
      if (dist > 0.1) {
        this.fleeDir = new THREE.Vector3(-dx, 0, -dz).normalize();
        this.fleeTime = 3;
      }
      return;
    }

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

    if (dist < 1.4) {
      this.character.overrideFacing(Math.atan2(dx, dz));
      this.character.setMove(new THREE.Vector3(), false);
      if (this.punchCooldown <= 0 && this.character.startAction('punch', 0.5)) {
        this.punchCooldown = 1.2;
        this.pendingPunch = true;
      }
    } else {
      this.character.setMove(new THREE.Vector3(dx / dist, 0, dz / dist), true);
    }
    this.character.update(dt);
  }

  canReceiveVehicleImpact(): boolean {
    return !this.dead && !this.knockedDown && this.impactCooldown <= 0;
  }

  /** Throw an occupied-car driver through the doorway, then let them recover. */
  pullFromVehicle(
    position: THREE.Vector3,
    yaw: number,
    side: 1 | -1,
    impact: THREE.Vector3
  ): void {
    if (this.dead || this.knockedDown) return;
    this.vehicleTransition = null;
    this.brawlTarget = null;
    this.pendingPunch = false;
    this.fleeDir = impact.clone().setY(0);
    if (this.fleeDir.lengthSq() < 0.001) this.fleeDir.set(side, 0, 0);
    this.fleeDir.normalize();
    this.fleeTime = 4;
    this.impactCooldown = 3;
    this.knockedDown = true;
    this.knockdownTimer = 2.4;
    this.character.teleport(position.x, position.y, position.z);
    this.character.setVehicleTransitionPose(position, yaw, 0.9, side, true);
    this.game.combat.unregister(this.character.collider);
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
  }

  private standUp(): void {
    const landing = this.ragdoll?.position() ?? this.character.position();
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.character.dispose();
    this.character = new Character(
      this.game,
      this.outfit,
      landing.x,
      landing.z,
      this.heightScale,
      PEDESTRIAN_COLLISION_GROUPS
    );
    this.game.combat.register(this.character.collider, this);
    this.knockedDown = false;
    this.impactCooldown = 0.8;
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

  /** Run over or beaten: hand the body to physics with the impact velocity. */
  die(impact: THREE.Vector3): void {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.impactCooldown = Infinity;
    this.game.combat.unregister(this.character.collider);
    // The ragdoll steals the rig's meshes before the character is disabled.
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
  }

  position(): THREE.Vector3 {
    return this.ragdoll ? this.ragdoll.position() : this.character.position();
  }

  dispose(): void {
    const transition = this.vehicleTransition;
    if (transition) {
      if (transition.vehicle.driver === this) transition.vehicle.driver = null;
      transition.vehicle.setDoorOpen(transition.side, false);
      this.vehicleTransition = null;
    }
    this.game.npcs.forgetPedestrian(this);
    this.game.combat.unregister(this.character.collider);
    this.ragdoll?.dispose();
    this.character.dispose();
  }
}
