import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import type { PlayerInput } from '../core/Input';
import type { CameraTarget } from '../render/Viewports';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Ragdoll } from './Ragdoll';
import { Vehicle } from './Vehicle';
import { Wanted } from '../gameplay/Wanted';
import { Inventory } from '../gameplay/Inventory';
import type { CombatTarget } from '../gameplay/Combat';
import { MeleeDef, PLAYER_HEALTH, WeaponDef, WeaponId } from '../gameplay/Weapons';
import { buildWeaponMesh } from './WeaponMeshes';
import { cellToWorld, nearestRoadCell, worldToCell } from '../world/CityMap';

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

export class Player implements Entity, CameraTarget, CombatTarget {
  character: Character;
  readonly wanted: Wanted;
  vehicle: Vehicle | null = null;
  /** Set each fixed step by Game before update(). */
  input: PlayerInput | null = null;
  /** Camera view yaw, for camera-relative on-foot movement. */
  cameraYaw = 0;
  prompt: string | null = null;
  readonly inventory = new Inventory();
  health = PLAYER_HEALTH;
  armour = 0;
  dead = false;
  /** Message for this player's HUD center slot ("WASTED"). */
  hudMessage: string | null = null;
  private balance = 0;
  private attackCooldown = 0;
  private heldWeaponId: WeaponId = 'fists';
  /** Melee damage waiting for the swing to reach its contact frame. */
  private pendingMelee: MeleeDef | null = null;
  /** Rate limit on gunfire wanted-heat so automatics don't stack it per shot. */
  private shotHeatCooldown = 0;
  /** Rate limit on vehicle contact damage. */
  private vehicleHitCooldown = 0;
  private respawnTimer = 0;
  private ragdoll: Ragdoll | null = null;

  constructor(
    private game: Game,
    readonly index: 0 | 1,
    x: number,
    z: number
  ) {
    this.character = new Character(game, index === 0 ? P1_OUTFIT : P2_OUTFIT, x, z);
    this.wanted = new Wanted(game, this);
    game.combat.register(this.character.collider, this);
  }

  // CombatTarget
  alive(): boolean {
    return !this.dead;
  }

  position(): THREE.Vector3 {
    return this.character.position();
  }

  takeHit(damage: number, dir: THREE.Vector3, _weapon: WeaponDef, _attacker: Player | null): void {
    if (this.dead || this.driving) return;
    const absorbed = Math.min(this.armour, damage * 0.7);
    this.armour -= absorbed;
    this.health -= damage - absorbed;
    this.character.flinch();
    if (this.health <= 0) this.die(dir);
  }

  private die(impactDir: THREE.Vector3): void {
    this.dead = true;
    this.health = 0;
    this.hudMessage = 'WASTED';
    this.respawnTimer = 4;
    this.game.combat.unregister(this.character.collider);
    // The ragdoll steals the rig's meshes (and drops any held weapon).
    const impact = impactDir.clone().setY(0).normalize().multiplyScalar(5);
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
    this.wanted.clear();
  }

  private respawn(): void {
    const deathPos = this.character.position();
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.character.dispose();
    const { cx, cz } = worldToCell(deathPos.x, deathPos.z);
    const cell = nearestRoadCell(cx, cz);
    const spot = cell ? cellToWorld(cell.cx, cell.cz) : { x: deathPos.x, z: deathPos.z };
    this.character = new Character(
      this.game,
      this.index === 0 ? P1_OUTFIT : P2_OUTFIT,
      spot.x,
      spot.z
    );
    this.game.combat.register(this.character.collider, this);
    this.health = PLAYER_HEALTH;
    this.armour = 0;
    this.dead = false;
    this.hudMessage = null;
    this.balance = Math.max(0, this.balance - 100); // hospital fee
    this.inventory.loseReserves();
    this.heldWeaponId = 'fists'; // re-attach the current weapon to the new rig
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
    this.vehicleHitCooldown = Math.max(0, this.vehicleHitCooldown - dt);
    const input = this.input;
    this.prompt = null;
    if (this.dead) {
      this.ragdoll?.update();
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }
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
    this.updateCombat(input, dt);
    this.character.update(dt);

    const nearest = this.nearestVehicle();
    if (nearest) {
      this.prompt = 'E / Y — steal car';
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
      const dir = this.game.combat.acquireAim(muzzle, facing, def.range, this);
      this.game.combat.fireHitscan(def, muzzle, dir, this, this.character.collider);
      this.game.audio.gunshot(def.id);
      if (this.shotHeatCooldown <= 0 && this.game.combat.anyTargetNear(pos, 30, this)) {
        this.game.reportCrime(this, def.heatPerShot);
        this.shotHeatCooldown = 1.2;
      }
      if (inv.magCount() === 0 && inv.startReload()) this.game.audio.reloadClick();
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
    this.character.teleport(t.x + right.x * 2.4, Math.max(t.y, 0.1), t.z + right.z * 2.4);
    this.character.setEnabled(true);
  }

  /** Vehicle contact damage; scaled by impact speed, lethal at ragdoll speeds. */
  canReceiveVehicleImpact(): boolean {
    return !this.dead && !this.driving && this.vehicleHitCooldown <= 0;
  }

  notifyVehicleImpact(): void {
    this.vehicleHitCooldown = 0.4;
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
