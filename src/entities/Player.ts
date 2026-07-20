import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import type { PlayerInput } from '../core/Input';
import { PEDESTRIAN_COLLISION_GROUPS } from '../core/const';
import type { CameraTarget } from '../render/Viewports';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Ragdoll } from './Ragdoll';
import { TrafficCar } from './TrafficCar';
import { Vehicle } from './Vehicle';
import type { Drivable, DriveCommand } from './Drivable';
import { Wanted } from '../gameplay/Wanted';
import { Inventory } from '../gameplay/Inventory';
import type { CombatTarget } from '../gameplay/Combat';
import { MeleeDef, PLAYER_ARMOUR_MAX, PLAYER_HEALTH, VEHICLE_IMPACT, WeaponDef, WeaponId } from '../gameplay/Weapons';
import { buildWeaponMesh } from './WeaponMeshes';
import { cellToWorld, heightAt, nearestRoadCell, worldToCell } from '../world/CityMap';
import type { PlayerSaveState } from '../save/GameSave';

const ENTER_RADIUS = 3.5;
const ENTER_VEHICLE_TIME = 0.9;
const EXIT_VEHICLE_TIME = 0.75;
const CARJACK_TIME = 1.6;
const KNOCKDOWN_TIME = 2.6;

interface VehicleTransition {
  kind: 'enter' | 'exit' | 'carjack';
  vehicle: Drivable;
  elapsed: number;
  duration: number;
  side: 1 | -1;
  startFeet: THREE.Vector3;
  startYaw: number;
  occupantEjected: boolean;
  occupantProfile?: TrafficCar['driverProfile'];
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

function transitionCommand(vehicle: Drivable): DriveCommand {
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: vehicle.kind === 'car',
    descend: false,
  };
}

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

export class Player implements Entity, CameraTarget, CombatTarget {
  character: Character;
  readonly wanted: Wanted;
  vehicle: Drivable | null = null;
  /** Set each fixed step by Game before update(). */
  input: PlayerInput | null = null;
  /** Camera view yaw, for camera-relative on-foot movement. */
  cameraYaw = 0;
  prompt: string | null = null;
  readonly inventory = new Inventory();
  health = PLAYER_HEALTH;
  armour = 0;
  invincible = false;
  dead = false;
  knockedDown = false;
  /** Message for this player's HUD center slot ("WASTED"). */
  hudMessage: string | null = null;
  private balance = 500;
  private attackCooldown = 0;
  private heldWeaponId: WeaponId = 'fists';
  /** Melee damage waiting for the swing to reach its contact frame. */
  private pendingMelee: MeleeDef | null = null;
  /** Rate limit on gunfire wanted-heat so automatics don't stack it per shot. */
  private shotHeatCooldown = 0;
  /** Rate limit on vehicle contact damage. */
  private vehicleHitCooldown = 0;
  private respawnTimer = 0;
  private knockdownTimer = 0;
  private ragdoll: Ragdoll | null = null;
  private vehicleTransition: VehicleTransition | null = null;
  private vehicleDoorSide: 1 | -1 = 1;
  private respawnCost = 100;
  private nearbyVehicles: Drivable[] = [];

  get canSave(): boolean {
    return !this.dead && !this.knockedDown && this.ragdoll === null && this.vehicleTransition === null;
  }

  constructor(
    private game: Game,
    readonly index: 0 | 1,
    x: number,
    z: number
  ) {
    this.character = new Character(
      game,
      index === 0 ? P1_OUTFIT : P2_OUTFIT,
      x,
      z,
      1,
      PEDESTRIAN_COLLISION_GROUPS
    );
    this.wanted = new Wanted(game, this);
    game.combat.register(this.character.collider, this);
  }

  // CombatTarget
  alive(): boolean {
    return !this.dead;
  }

  position(): THREE.Vector3 {
    return this.ragdoll ? this.ragdoll.position() : this.character.position();
  }

  takeHit(damage: number, dir: THREE.Vector3, _weapon: WeaponDef, _attacker: Player | null): void {
    if (this.invincible || this.dead || this.knockedDown || this.driving) return;
    const absorbed = Math.min(this.armour, damage * 0.7);
    this.armour -= absorbed;
    this.health -= damage - absorbed;
    this.character.flinch();
    if (this.health <= 0) this.die(dir);
  }

  /** Apply a car hit, entering a recoverable ragdoll state when fast enough. */
  takeVehicleHit(damage: number, impact: THREE.Vector3, knockDown: boolean): void {
    if (this.invincible || !this.canReceiveVehicleImpact()) return;
    this.vehicleHitCooldown = 0.8;
    this.takeHit(damage, impact, VEHICLE_IMPACT, null);
    if (!this.dead && knockDown) this.knockDown(impact);
  }

  applyBlast(velocityChange: THREE.Vector3): void {
    if (!this.invincible && !this.dead && !this.knockedDown && !this.driving) this.knockDown(velocityChange);
  }

  /** Crash forces can injure occupants even while the chassis protects them. */
  takeOccupantCrashDamage(damage: number, origin: THREE.Vector3): void {
    if (this.invincible || this.dead || !this.vehicle || damage <= 0) return;
    const absorbed = Math.min(this.armour, damage * 0.55);
    this.armour -= absorbed;
    this.health -= damage - absorbed;
    if (this.health > 0) return;
    const vehicle = this.vehicle;
    this.ejectFromDestroyedVehicle(vehicle, origin);
    const away = this.position().sub(origin).setY(0);
    if (away.lengthSq() < 0.01) away.set(1, 0, 0);
    this.die(away.normalize());
  }

  private knockDown(impact: THREE.Vector3): void {
    this.knockedDown = true;
    this.knockdownTimer = KNOCKDOWN_TIME;
    this.pendingMelee = null;
    this.game.combat.unregister(this.character.collider);
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
  }

  private standUp(): void {
    const landing = this.ragdoll?.position() ?? this.character.position();
    this.rebuildCharacter(landing.x, landing.z, undefined, this.character.getFacing());
    this.character.flinch();
    this.knockedDown = false;
    this.vehicleHitCooldown = 0.8;
  }

  private die(impactDir: THREE.Vector3): void {
    this.dead = true;
    this.health = 0;
    this.knockedDown = false;
    this.hudMessage = 'WASTED';
    this.respawnCost = 100;
    this.respawnTimer = 4;
    this.game.combat.unregister(this.character.collider);
    // The ragdoll steals the rig's meshes (and drops any held weapon).
    const impact = impactDir.clone().setY(0).normalize().multiplyScalar(5);
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
    this.wanted.clear();
  }

  private respawn(): void {
    const deathPos = this.position();
    const { cx, cz } = worldToCell(deathPos.x, deathPos.z);
    const cell = nearestRoadCell(cx, cz);
    const spot = cell ? cellToWorld(cell.cx, cell.cz) : { x: deathPos.x, z: deathPos.z };
    this.rebuildCharacter(spot.x, spot.z, undefined, this.character.getFacing());
    this.health = PLAYER_HEALTH;
    this.armour = 0;
    this.dead = false;
    this.knockdownTimer = 0;
    this.hudMessage = null;
    this.balance = Math.max(0, this.balance - this.respawnCost);
    this.inventory.loseReserves();
    this.heldWeaponId = 'fists'; // re-attach the current weapon to the new rig
  }

  private rebuildCharacter(x: number, z: number, surfaceY?: number, heading = 0): void {
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.game.combat.unregister(this.character.collider);
    this.character.dispose();
    this.character = new Character(
      this.game,
      this.index === 0 ? P1_OUTFIT : P2_OUTFIT,
      x,
      z,
      1,
      PEDESTRIAN_COLLISION_GROUPS
    );
    if (surfaceY !== undefined) this.character.teleport(x, surfaceY, z);
    this.character.setFacing(heading);
    this.character.rig.setHeldItem(buildWeaponMesh(this.inventory.current));
    this.heldWeaponId = this.inventory.current;
    this.game.combat.register(this.character.collider, this);
  }

  captureSaveState(): PlayerSaveState {
    if (!this.canSave) throw new Error('Player state is temporarily unsafe to save.');
    const heading = this.getHeading();
    const actor = this.vehicle?.body.translation() ?? this.character.body.translation();
    const x = actor.x;
    const z = actor.z;
    const ceilingY = this.vehicle ? actor.y + 0.5 : this.character.position().y + 1.5;
    const surfaceY = this.game.surfaceHeightBelow(
      x,
      z,
      ceilingY,
      this.vehicle?.kind === 'helicopter' ? 250 : this.vehicle ? 12 : 4,
      this.vehicle?.body ?? this.character.body
    );
    return {
      position: { x, z, surfaceY },
      heading,
      health: THREE.MathUtils.clamp(this.health, 1, PLAYER_HEALTH),
      armour: THREE.MathUtils.clamp(this.armour, 0, PLAYER_ARMOUR_MAX),
      money: Math.max(0, Math.floor(this.balance)),
      inventory: this.inventory.snapshot(),
    };
  }

  restoreSaveState(state: PlayerSaveState): void {
    const transitionVehicle = this.vehicleTransition?.vehicle;
    if (transitionVehicle) transitionVehicle.setDoorOpen(this.vehicleTransition!.side, false);
    if (this.vehicle) {
      if (this.vehicle.driver === this) this.vehicle.driver = null;
      this.vehicle.command = transitionCommand(this.vehicle);
      this.vehicle.setDoorOpen(this.vehicleDoorSide, false);
    }
    this.vehicle = null;
    this.vehicleTransition = null;
    this.inventory.restore(state.inventory);
    this.rebuildCharacter(state.position.x, state.position.z, state.position.surfaceY, state.heading);
    this.character.setEnabled(true);
    this.health = state.health;
    this.armour = state.armour;
    this.balance = state.money;
    this.dead = false;
    this.knockedDown = false;
    this.hudMessage = null;
    this.prompt = null;
    this.input = null;
    this.attackCooldown = 0;
    this.pendingMelee = null;
    this.shotHeatCooldown = 0;
    this.vehicleHitCooldown = 0;
    this.respawnTimer = 0;
    this.knockdownTimer = 0;
    this.respawnCost = 100;
    this.wanted.reset();
    this.game.input.clearQueuedInput();
  }

  /** Resolve a close-range police arrest, including a star-scaled fine. */
  bust(fine: number): void {
    if (this.dead) return;
    const vehiclePos = this.vehicle?.body.translation();
    const arrestPos = vehiclePos
      ? new THREE.Vector3(vehiclePos.x, vehiclePos.y, vehiclePos.z)
      : this.position();
    if (this.vehicle) {
      this.vehicle.driver = null;
      this.vehicle.setDoorOpen(this.vehicleDoorSide, false);
      this.vehicle = null;
    }
    this.vehicleTransition = null;
    this.pendingMelee = null;
    this.character.teleport(
      arrestPos.x,
      this.game.surfaceHeightBelow(arrestPos.x, arrestPos.z, arrestPos.y + 1),
      arrestPos.z
    );
    this.character.setEnabled(false);
    this.dead = true;
    this.hudMessage = 'BUSTED';
    this.respawnTimer = 3;
    this.respawnCost = Math.max(0, Math.floor(fine));
    this.wanted.clear();
    this.game.audio.busted();
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

  /** Restore maximum player health and armour for developer testing. */
  restoreVitals(): void {
    if (this.dead) return;
    this.health = PLAYER_HEALTH;
    this.armour = PLAYER_ARMOUR_MAX;
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
    this.vehicleHitCooldown = Math.max(0, this.vehicleHitCooldown - dt);
    const input = this.input;
    this.prompt = null;
    if (this.dead) {
      this.ragdoll?.update();
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
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
    if (!input) return;

    if (this.vehicle) {
      this.vehicle.command = {
        steer: input.steer,
        throttle: input.throttle,
        brake: input.brake,
        handbrake: input.handbrake,
        descend: input.descend,
      };
      if (this.vehicle.kind === 'helicopter') {
        const interact = this.game.input.interactLabel(this.index);
        this.prompt = this.vehicle.canExit()
          ? `Space / A ascend · Shift / B descend · ${interact} exit`
          : 'Space ascend · Shift descend · land to exit';
      } else if (this.vehicle instanceof Vehicle && !this.vehicle.burning &&
          this.vehicle.getSpeed() < 1.2 && this.vehicle.healthFraction < 0.98) {
        const repair = this.game.input.inputMethod(this.index) === 'gamepad' ? 'X' : 'R';
        this.prompt = `${repair} roadside repair $75 · ${this.game.input.interactLabel(this.index)} exit`;
        if (input.reload && this.spendMoney(75)) {
          this.vehicle.repair(90);
          this.game.audio.repairChime();
        }
      }
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
      this.character.setMove(dir, input.sprint, mag);
    } else {
      this.character.setMove(new THREE.Vector3(), false);
    }
    if (input.jump) this.character.jump();
    this.updateCombat(input, dt);
    this.character.update(dt);

    const nearest = this.nearestVehicle();
    if (nearest) {
      const interact = this.game.input.interactLabel(this.index);
      this.prompt = nearest.driver instanceof TrafficCar
        ? `${interact} — pull driver out`
        : nearest.kind === 'helicopter'
          ? `${interact} — enter helicopter`
          : `${interact} — enter car`;
      if (input.interact) this.enterVehicle(nearest);
    }
  }

  private updateCombat(input: PlayerInput, dt: number): void {
    const inv = this.inventory;
    inv.tick(dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    if (input.weaponNext) inv.cycle(1);
    if (input.weaponPrev) inv.cycle(-1);
    if (this.heldWeaponId !== inv.current) {
      this.heldWeaponId = inv.current;
      this.character.rig.setHeldItem(buildWeaponMesh(inv.current));
    }
    const def = inv.def();

    const aiming = input.aim && def.kind === 'gun';
    this.character.setAimPose(aiming ? (def.twoHanded ? 'long' : 'pistol') : 'none');
    if (aiming) this.character.overrideFacing(this.cameraYaw);

    if (input.reload && inv.startReload()) this.game.audio.reloadClick();
    this.shotHeatCooldown = Math.max(0, this.shotHeatCooldown - dt);

    // Resolve a queued melee hit once the swing reaches its contact frame.
    if (this.pendingMelee) {
      const t = this.character.actionProgress();
      if (t === null || t >= 0.4) {
        const hits = this.game.combat.meleeSweep(
          this.pendingMelee,
          this.character.position(),
          this.character.getFacing(),
          this
        );
        if (hits > 0) this.game.audio.thwack();
        this.pendingMelee = null;
      }
    }

    const wantsAttack =
      def.kind === 'gun' && def.automatic ? input.attack || input.attackPressed : input.attackPressed;
    if (!wantsAttack || this.attackCooldown > 0) return;
    if (def.kind === 'melee') {
      if (!this.character.startAction(def.id === 'fists' ? 'punch' : 'swing', def.fireInterval, def.twoHanded)) {
        return;
      }
      this.attackCooldown = def.fireInterval;
      this.pendingMelee = def;
    } else {
      if (!inv.canFire()) {
        if (inv.reloading <= 0 && inv.startReload()) this.game.audio.reloadClick();
        return;
      }
      inv.consumeRound();
      this.attackCooldown = def.fireInterval;
      const facing = this.character.getFacing();
      const pos = this.character.position();
      // Muzzle at chest height, pushed clear of the player's own capsule.
      const muzzle = new THREE.Vector3(
        pos.x + Math.sin(facing) * 0.45,
        pos.y + 1.35,
        pos.z + Math.cos(facing) * 0.45
      );
      const dir = this.game.combat.acquireAim(
        muzzle,
        facing,
        def.range,
        this,
        this.game.settings.values.aimAssist ? 0.2 : 0
      );
      this.game.combat.fireHitscan(def, muzzle, dir, this, this.character.collider);
      this.game.audio.gunshot(def.id);
      if (this.shotHeatCooldown <= 0 && this.game.combat.anyTargetNear(pos, 30, this)) {
        this.game.reportCrime(this, def.heatPerShot);
        this.shotHeatCooldown = 1.2;
      }
      if (inv.magCount() === 0 && inv.startReload()) this.game.audio.reloadClick();
    }
  }

  private nearestVehicle(): Drivable | null {
    const pos = this.character.position();
    let best: Drivable | null = null;
    let bestDist = ENTER_RADIUS;
    for (const v of this.game.vehiclesNear(pos.x, pos.z, ENTER_RADIUS, this.nearbyVehicles)) {
      if (v.destroyed) continue;
      const occupiedTraffic = v.driver instanceof TrafficCar && v.getSpeed() < 2.5;
      if (v.driver && !occupiedTraffic) continue;
      const t = v.body.translation();
      const d = Math.hypot(t.x - pos.x, t.z - pos.z);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    return best;
  }

  enterVehicle(v: Drivable): void {
    if (this.vehicle || this.vehicleTransition || v.destroyed) return;
    const occupant = v.driver instanceof TrafficCar ? v.driver : null;
    if (v.driver && !occupant) return;
    if (occupant && v.getSpeed() >= 2.5) return;
    const startFeet = this.character.position();
    const t = v.body.translation();
    const local = startFeet
      .clone()
      .sub(new THREE.Vector3(t.x, t.y, t.z))
      .applyQuaternion(v.quaternion().invert());
    // Melbourne traffic is right-hand drive; occupied cars are taken from the
    // driver's +X door. Empty cars still use whichever side is nearer.
    const side: 1 | -1 = occupant ? 1 : local.x >= 0 ? 1 : -1;

    v.command = transitionCommand(v);
    occupant?.prepareForCarjacking();
    v.driver = this;
    this.vehicle = v;
    v.setDoorOpen(side, true);
    this.vehicleDoorSide = side;
    this.pendingMelee = null;
    this.vehicleTransition = {
      kind: occupant ? 'carjack' : 'enter',
      vehicle: v,
      elapsed: 0,
      duration: occupant ? CARJACK_TIME : ENTER_VEHICLE_TIME,
      side,
      startFeet,
      startYaw: this.character.getFacing(),
      occupantEjected: false,
      occupantProfile: occupant?.driverProfile,
    };
    this.character.beginVehicleTransition(true);
    this.game.audio.carDoor();
  }

  exitVehicle(): void {
    const v = this.vehicle;
    if (!v || this.vehicleTransition) return;
    if (!v.canExit()) return;
    // Handbrake only: `brake` acts as reverse throttle once nearly stopped,
    // which would make the abandoned car creep backwards.
    v.command = transitionCommand(v);
    v.setDoorOpen(this.vehicleDoorSide, true);
    this.vehicleTransition = {
      kind: 'exit',
      vehicle: v,
      elapsed: 0,
      duration: EXIT_VEHICLE_TIME,
      side: this.vehicleDoorSide,
      startFeet: v.seatPosition(this.vehicleDoorSide),
      startYaw: this.character.getFacing(),
      occupantEjected: false,
    };
    this.character.beginVehicleTransition(false);
    this.game.audio.carDoor();
  }

  /** Emergency exit used immediately before an occupied vehicle's blast. */
  ejectFromDestroyedVehicle(vehicle: Drivable, origin: THREE.Vector3): void {
    if (this.vehicle !== vehicle) return;
    this.vehicleTransition = null;
    this.pendingMelee = null;
    vehicle.driver = null;
    vehicle.setDoorOpen(this.vehicleDoorSide, false);
    const outside = vehicle.doorPosition(this.vehicleDoorSide, 1.35);
    const away = outside.clone().sub(origin).setY(0);
    if (away.lengthSq() < 0.01) away.set(1, 0, 0).applyQuaternion(vehicle.quaternion());
    away.normalize();
    outside.addScaledVector(away, 0.8);
    this.vehicle = null;
    this.character.setEnabled(true);
    this.character.teleport(
      outside.x,
      Math.max(outside.y, heightAt(outside.x, outside.z) + 0.1),
      outside.z
    );
    this.character.setFacing(Math.atan2(away.x, away.z));
    this.vehicleHitCooldown = 0.8;
  }

  private updateVehicleTransition(dt: number): void {
    const transition = this.vehicleTransition;
    if (!transition) return;
    transition.elapsed = Math.min(transition.duration, transition.elapsed + dt);
    const p = transition.elapsed / transition.duration;
    const v = transition.vehicle;
    const side = transition.side;

    // Keep a moving or sloped car under control while the player crosses the
    // doorway. The anchor points are recomputed so the animation follows it.
    v.command = transitionCommand(v);
    const seat = v.seatPosition(side);
    const doorway = v.doorPosition(side, 0.18);
    const outside = v.doorPosition(side, 1.05);
    const t = v.body.translation();
    const inwardYaw = Math.atan2(t.x - outside.x, t.z - outside.z);
    const feet = new THREE.Vector3();
    let seatBlend: number;
    let visible: boolean;
    let yaw: number;
    let carjackPull = 0;

    if (transition.kind === 'enter') {
      if (p < 0.42) {
        feet.lerpVectors(transition.startFeet, outside, ease(p / 0.42));
      } else if (p < 0.7) {
        feet.lerpVectors(outside, doorway, ease((p - 0.42) / 0.28));
      } else {
        feet.lerpVectors(doorway, seat, ease((p - 0.7) / 0.3));
      }
      seatBlend = ease((p - 0.42) / 0.58);
      yaw = lerpYaw(transition.startYaw, inwardYaw, ease(p / 0.38));
      visible = p < 0.9;
    } else if (transition.kind === 'carjack') {
      if (p < 0.28) {
        feet.lerpVectors(transition.startFeet, outside, ease(p / 0.28));
      } else if (p < 0.58) {
        feet.copy(outside);
      } else if (p < 0.78) {
        feet.lerpVectors(outside, doorway, ease((p - 0.58) / 0.2));
      } else {
        feet.lerpVectors(doorway, seat, ease((p - 0.78) / 0.22));
      }
      seatBlend = ease((p - 0.58) / 0.42);
      yaw = lerpYaw(transition.startYaw, inwardYaw, ease(p / 0.25));
      visible = p < 0.92;
      carjackPull = ease((p - 0.28) / 0.3);
      if (!transition.occupantEjected && p >= 0.48) {
        transition.occupantEjected = true;
        this.game.npcs.ejectTrafficDriver(v, side, transition.occupantProfile);
        this.game.audio.thwack();
        this.game.reportCrime(this, 28);
      }
    } else {
      if (p < 0.38) {
        feet.lerpVectors(seat, doorway, ease(p / 0.38));
      } else if (p < 0.82) {
        feet.lerpVectors(doorway, outside, ease((p - 0.38) / 0.44));
      } else {
        feet.copy(outside);
      }
      seatBlend = 1 - ease(p / 0.82);
      yaw = inwardYaw;
      visible = p > 0.08;
    }

    this.character.setVehicleTransitionPose(feet, yaw, seatBlend, side, visible, carjackPull);
    if (p < 1) return;

    this.vehicleTransition = null;
    if (transition.kind !== 'exit') {
      v.setDoorOpen(side, false);
      this.character.setEnabled(false);
      return;
    }

    v.driver = null;
    v.setDoorOpen(side, false);
    this.vehicle = null;
    this.vehicleHitCooldown = Math.max(this.vehicleHitCooldown, 0.6);
    this.character.setFacing(inwardYaw);
    this.character.teleport(
      outside.x,
      Math.max(outside.y, heightAt(outside.x, outside.z) + 0.1),
      outside.z
    );
    this.character.setEnabled(true);
  }

  /** Vehicle contact damage is ignored while driving, downed, or on cooldown. */
  canReceiveVehicleImpact(): boolean {
    return !this.dead && !this.knockedDown && !this.driving && this.vehicleHitCooldown <= 0;
  }

  // CameraTarget
  getFocus(out: THREE.Vector3): void {
    if (this.ragdoll) {
      out.copy(this.ragdoll.position());
      out.y += 0.4;
    } else if (this.vehicle) {
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
