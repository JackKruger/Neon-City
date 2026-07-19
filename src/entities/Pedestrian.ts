import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import { PEDESTRIAN_COLLISION_GROUPS } from '../core/const';
import type { CombatTarget } from '../gameplay/Combat';
import type { Player } from './Player';
import { MeleeDef, PED_HEALTH, WEAPONS, WeaponDef } from '../gameplay/Weapons';
import { Character } from './Character';
import type { Outfit } from './HumanRig';
import { Ragdoll } from './Ragdoll';
import { CellRef, lanePoint, nextRoadCell } from '../world/RoadGraph';

const WALK_DIR = new THREE.Vector3();

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
    this.waypoint = lanePoint(from, to, 0.4 + this.jitter);
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
      const next = nextRoadCell(this.from, this.to, Math.random());
      this.from = this.to;
      this.to = next;
      this.waypoint = lanePoint(this.from, this.to, 0.4 + this.jitter);
    }
    WALK_DIR.set(this.waypoint.x - pos.x, 0, this.waypoint.z - pos.z).normalize();
    this.character.setMove(WALK_DIR, false);
    this.character.update(dt);
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
    this.game.combat.unregister(this.character.collider);
    this.ragdoll?.dispose();
    this.character.dispose();
  }
}
