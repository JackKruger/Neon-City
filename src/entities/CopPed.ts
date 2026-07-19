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
  private health = COP_HEALTH;
  private fireCooldown = 1.2; // grace period after deploying
  private punchCooldown = 0;
  private pendingPunch = false;

  constructor(
    private game: Game,
    private target: Player,
    x: number,
    z: number
  ) {
    this.character = new Character(game, COP_OUTFIT, x, z, 1, PEDESTRIAN_COLLISION_GROUPS);
    this.character.rig.setHeldItem(buildWeaponMesh('pistol'));
    game.combat.register(this.character.collider, this);
  }

  alive(): boolean {
    return !this.dead;
  }

  position(): THREE.Vector3 {
    return this.ragdoll ? this.ragdoll.position() : this.character.position();
  }

  takeHit(damage: number, dir: THREE.Vector3, weapon: WeaponDef, attacker: Player | null): void {
    if (this.dead) return;
    this.health -= damage;
    if (this.health <= 0) {
      this.die(dir.clone().multiplyScalar(weapon.kind === 'melee' ? 3.5 + weapon.knockback : 6));
      // Killing an officer escalates hard, and their sidearm hits the street.
      this.game.reportCrime(attacker, 70);
      return;
    }
    this.character.flinch();
    if (weapon.kind === 'melee') this.game.reportCrime(attacker, weapon.heatPerHit);
  }

  private die(impact: THREE.Vector3): void {
    this.dead = true;
    this.health = 0;
    this.game.combat.unregister(this.character.collider);
    const pos = this.character.position();
    this.ragdoll = new Ragdoll(this.game, this.character.rig, impact);
    this.character.setEnabled(false);
    this.game.pickups.push(new Pickup(this.game, 'pistol', 12, pos.x, pos.y, pos.z));
  }

  update(dt: number): void {
    if (this.dead) {
      this.deadFor += dt;
      this.ragdoll?.update();
      return;
    }
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.punchCooldown = Math.max(0, this.punchCooldown - dt);

    const pos = this.character.position();
    const targetPos = this.target.position();
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
        this.fireCooldown = COP_PISTOL.fireInterval;
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
        this.game.combat.fireHitscan(COP_PISTOL, muzzle, aim, null, this.character.collider);
        this.game.audio.gunshot('pistol', dist);
      }
    } else {
      // Chase.
      this.character.setAimPose('none');
      this.character.setMove(DIR.clone().divideScalar(Math.max(dist, 0.1)), true);
    }
    this.character.update(dt);
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
