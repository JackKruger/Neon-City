import { WEAPONS, WEAPON_ORDER, WeaponDef, WeaponId } from './Weapons';
import type { InventorySaveState } from '../save/GameSave';

/** Owned weapons plus per-gun magazine and reserve ammo for one character. */
export class Inventory {
  private owned = new Set<WeaponId>(['fists']);
  private mag = new Map<WeaponId, number>();
  private reserve = new Map<WeaponId, number>();
  current: WeaponId = 'fists';
  /** Seconds left on the current weapon's reload, 0 when idle. */
  reloading = 0;

  snapshot(): InventorySaveState {
    return {
      current: this.current,
      weapons: WEAPON_ORDER
        .filter((id) => this.owned.has(id))
        .map((id) => ({ id, magazine: this.mag.get(id) ?? 0, reserve: this.reserve.get(id) ?? 0 })),
    };
  }

  restore(snapshot: InventorySaveState): void {
    this.owned = new Set(snapshot.weapons.map((weapon) => weapon.id));
    this.mag = new Map(snapshot.weapons.map((weapon) => [weapon.id, weapon.magazine]));
    this.reserve = new Map(snapshot.weapons.map((weapon) => [weapon.id, weapon.reserve]));
    this.current = snapshot.current;
    this.reloading = 0;
  }

  def(): WeaponDef {
    return WEAPONS[this.current];
  }

  has(id: WeaponId): boolean {
    return this.owned.has(id);
  }

  magCount(): number {
    return this.mag.get(this.current) ?? 0;
  }

  reserveCount(): number {
    return this.reserve.get(this.current) ?? 0;
  }

  /** Grant a weapon (with ammo for guns) and switch to it if newly acquired. */
  give(id: WeaponId, ammo = 0): void {
    const fresh = !this.owned.has(id);
    this.owned.add(id);
    if (WEAPONS[id].kind === 'gun') this.addAmmo(id, ammo);
    if (fresh) {
      this.current = id;
      this.reloading = 0;
    }
  }

  addAmmo(id: WeaponId, amount: number): void {
    const def = WEAPONS[id];
    if (def.kind !== 'gun' || amount <= 0) return;
    // Fill the magazine first so a fresh pickup is immediately usable.
    const mag = this.mag.get(id) ?? 0;
    const intoMag = Math.min(def.magSize - mag, amount);
    this.mag.set(id, mag + intoMag);
    this.reserve.set(id, (this.reserve.get(id) ?? 0) + amount - intoMag);
  }

  /** Switch to the next/previous owned weapon. Cancels any reload in progress. */
  cycle(dir: 1 | -1): void {
    const n = WEAPON_ORDER.length;
    let i = WEAPON_ORDER.indexOf(this.current);
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (this.owned.has(WEAPON_ORDER[i])) {
        if (WEAPON_ORDER[i] !== this.current) this.reloading = 0;
        this.current = WEAPON_ORDER[i];
        return;
      }
    }
  }

  canFire(): boolean {
    const def = this.def();
    if (def.kind === 'melee') return true;
    return this.reloading <= 0 && this.magCount() > 0;
  }

  consumeRound(): void {
    this.mag.set(this.current, Math.max(0, this.magCount() - 1));
  }

  startReload(): boolean {
    const def = this.def();
    if (def.kind !== 'gun' || this.reloading > 0) return false;
    if (this.magCount() >= def.magSize || this.reserveCount() <= 0) return false;
    this.reloading = def.reloadTime;
    return true;
  }

  /** Advance the reload timer; moves reserve rounds into the mag on completion. */
  tick(dt: number): void {
    if (this.reloading <= 0) return;
    this.reloading -= dt;
    if (this.reloading > 0) return;
    this.reloading = 0;
    const def = this.def();
    if (def.kind !== 'gun') return;
    const take = Math.min(def.magSize - this.magCount(), this.reserveCount());
    this.mag.set(this.current, this.magCount() + take);
    this.reserve.set(this.current, this.reserveCount() - take);
  }

  /** Halve reserve ammo (death penalty). */
  loseReserves(): void {
    for (const [id, n] of this.reserve) this.reserve.set(id, Math.floor(n / 2));
  }

  /** Grant every weapon with full ammo (debug). */
  giveAll(): void {
    for (const id of WEAPON_ORDER) {
      const def = WEAPONS[id];
      this.give(id, def.kind === 'gun' ? def.magSize * 5 : 0);
    }
    this.current = 'fists';
  }
}
