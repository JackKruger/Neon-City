import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game } from '../core/Game';
import type { Player } from '../entities/Player';
import { GunDef, MeleeDef, WeaponDef } from './Weapons';

/** Anything that can be punched or shot. */
export interface CombatTarget {
  alive(): boolean;
  /** Ground-level position; chest offsets are applied by the combat service. */
  position(): THREE.Vector3;
  takeHit(damage: number, dir: THREE.Vector3, weapon: WeaponDef, attacker: Player | null): void;
}

const TO_TARGET = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Central hit resolution: a collider-handle → target registry, melee arc
 * sweeps, and (phase 3) gun hitscan. Owned by Game as `game.combat`.
 */
export class Combat {
  /** Registered targets keyed by collider handle, for hitscan lookups. */
  private byCollider = new Map<number, CombatTarget>();

  constructor(private game: Game) {}

  register(collider: RAPIER.Collider, target: CombatTarget): void {
    this.byCollider.set(collider.handle, target);
  }

  unregister(collider: RAPIER.Collider): void {
    this.byCollider.delete(collider.handle);
  }

  /**
   * Swing a melee arc centered on the attacker's facing; every live target in
   * range takes the hit. Same manual-overlap style as vehicle impacts.
   * @returns the number of targets hit
   */
  meleeSweep(
    def: MeleeDef,
    origin: THREE.Vector3,
    facingYaw: number,
    attacker: Player | null,
    exclude: object | null = attacker
  ): number {
    let hits = 0;
    const reach = def.range + 0.35; // target capsule radius
    for (const target of new Set(this.byCollider.values())) {
      if ((target as object) === exclude || !target.alive()) continue;
      const pos = target.position();
      const dx = pos.x - origin.x;
      const dz = pos.z - origin.z;
      if (Math.abs(pos.y - origin.y) > 1.5) continue;
      if (dx * dx + dz * dz > reach * reach) continue;
      let delta = Math.atan2(dx, dz) - facingYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > def.arc / 2) continue;
      TO_TARGET.set(dx, 0, dz);
      if (TO_TARGET.lengthSq() < 0.001) TO_TARGET.set(Math.sin(facingYaw), 0, Math.cos(facingYaw));
      target.takeHit(def.damage, TO_TARGET.clone().normalize(), def, attacker);
      hits++;
    }
    return hits;
  }

  /**
   * Soft aim assist: fire toward the chest of the closest live target inside
   * a narrow cone around the facing, or flat along the facing if none.
   */
  acquireAim(
    origin: THREE.Vector3,
    facingYaw: number,
    range: number,
    exclude?: object,
    cone = 0.2
  ): THREE.Vector3 {
    let best: CombatTarget | null = null;
    let bestDist = range;
    for (const target of new Set(this.byCollider.values())) {
      if ((target as object) === exclude || !target.alive()) continue;
      const pos = target.position();
      const dx = pos.x - origin.x;
      const dz = pos.z - origin.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bestDist || dist < 0.5) continue;
      let delta = Math.atan2(dx, dz) - facingYaw;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      if (Math.abs(delta) > cone) continue;
      best = target;
      bestDist = dist;
    }
    if (best) {
      const chest = best.position();
      return new THREE.Vector3(chest.x - origin.x, chest.y + 1.2 - origin.y, chest.z - origin.z).normalize();
    }
    return new THREE.Vector3(Math.sin(facingYaw), 0, Math.cos(facingYaw));
  }

  /**
   * Fire one trigger pull: `pellets` spread-perturbed rays. Registered targets
   * take damage with blood; anything else sparks. Emits tracers + muzzle glow.
   * @returns the number of pellets that hit a live target
   */
  fireHitscan(
    def: GunDef,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    attacker: Player | null,
    excludeCollider?: RAPIER.Collider
  ): number {
    const fx = this.game.fx;
    let hits = 0;
    for (let i = 0; i < def.pellets; i++) {
      const d = dir.clone();
      if (def.spread > 0) {
        const yaw = (Math.random() - 0.5) * 2 * def.spread;
        const pitch = (Math.random() - 0.5) * 2 * def.spread;
        d.applyAxisAngle(UP, yaw);
        d.y += pitch;
        d.normalize();
      }
      const ray = new RAPIER.Ray(origin, d);
      const hit = this.game.world.castRay(
        ray,
        def.range,
        true,
        undefined,
        undefined,
        excludeCollider,
        excludeCollider?.parent() ?? undefined
      );
      const end = origin.clone().addScaledVector(d, hit ? hit.timeOfImpact : def.range);
      fx.tracer(origin, end);
      if (!hit) continue;
      const target = this.byCollider.get(hit.collider.handle);
      if (target && target.alive()) {
        target.takeHit(def.damage, d, def, attacker);
        fx.blood(end);
        hits++;
      } else {
        fx.spark(end);
      }
    }
    fx.muzzle(origin.clone().addScaledVector(dir, 0.25));
    return hits;
  }

  /** Is any live target within `radius` of a point? Used for witness checks. */
  anyTargetNear(pos: THREE.Vector3, radius: number, exclude?: object): boolean {
    const r2 = radius * radius;
    for (const target of this.byCollider.values()) {
      if ((target as object) === exclude || !target.alive()) continue;
      const t = target.position();
      const dx = t.x - pos.x;
      const dz = t.z - pos.z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }
}
