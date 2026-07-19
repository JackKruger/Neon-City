/** Data-driven weapon definitions shared by players, cops and brawling peds. */

export type WeaponId = 'fists' | 'knife' | 'bat' | 'pistol' | 'smg' | 'shotgun';
export type GunId = 'pistol' | 'smg' | 'shotgun';

interface WeaponDefBase {
  id: WeaponId;
  name: string;
  /** Damage per hit (melee) or per pellet (guns). */
  damage: number;
  /** Seconds between attacks; also the melee swing duration. */
  fireInterval: number;
  twoHanded: boolean;
}

export interface MeleeDef extends WeaponDefBase {
  kind: 'melee';
  /** Reach from the attacker's center, meters. */
  range: number;
  /** Full arc width centered on facing, radians. */
  arc: number;
  /** Shove strength applied to surviving targets. */
  knockback: number;
  /** Wanted heat per landed hit on an NPC. */
  heatPerHit: number;
}

export interface GunDef extends WeaponDefBase {
  kind: 'gun';
  id: GunId;
  /** Hitscan length, meters. */
  range: number;
  /** Spread half-angle, radians. */
  spread: number;
  pellets: number;
  magSize: number;
  reloadTime: number;
  /** Hold-to-fire. */
  automatic: boolean;
  /** Wanted heat per shot fired near witnesses (cooldown-gated). */
  heatPerShot: number;
}

export type WeaponDef = MeleeDef | GunDef;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists',
    name: 'Fists',
    kind: 'melee',
    damage: 12,
    fireInterval: 0.4,
    twoHanded: false,
    range: 1.1,
    arc: (110 * Math.PI) / 180,
    knockback: 2,
    heatPerHit: 3,
  },
  knife: {
    id: 'knife',
    name: 'Knife',
    kind: 'melee',
    damage: 30,
    fireInterval: 0.5,
    twoHanded: false,
    range: 1.25,
    arc: (70 * Math.PI) / 180,
    knockback: 2,
    heatPerHit: 5,
  },
  bat: {
    id: 'bat',
    name: 'Baseball Bat',
    kind: 'melee',
    damage: 28,
    fireInterval: 0.75,
    twoHanded: true,
    range: 1.7,
    arc: (120 * Math.PI) / 180,
    knockback: 5,
    heatPerHit: 5,
  },
  pistol: {
    id: 'pistol',
    name: 'Pistol',
    kind: 'gun',
    damage: 26,
    fireInterval: 0.35,
    twoHanded: false,
    range: 60,
    spread: 0.01,
    pellets: 1,
    magSize: 12,
    reloadTime: 1.1,
    automatic: false,
    heatPerShot: 8,
  },
  smg: {
    id: 'smg',
    name: 'SMG',
    kind: 'gun',
    damage: 11,
    fireInterval: 0.09,
    twoHanded: false,
    range: 45,
    spread: 0.035,
    pellets: 1,
    magSize: 30,
    reloadTime: 1.5,
    automatic: true,
    heatPerShot: 3,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Shotgun',
    kind: 'gun',
    damage: 9,
    fireInterval: 0.9,
    twoHanded: true,
    range: 24,
    spread: 0.06,
    pellets: 7,
    magSize: 6,
    reloadTime: 1.8,
    automatic: false,
    heatPerShot: 10,
  },
};

/** Weapon cycling order. */
export const WEAPON_ORDER: WeaponId[] = ['fists', 'knife', 'bat', 'pistol', 'smg', 'shotgun'];

/** Pseudo-weapon so vehicle impacts flow through the same takeHit path. */
export const VEHICLE_IMPACT: MeleeDef = {
  id: 'fists',
  name: 'Vehicle',
  kind: 'melee',
  damage: 0, // scaled by impact speed at the call site
  fireInterval: 0,
  twoHanded: false,
  range: 0,
  arc: 0,
  knockback: 8,
  heatPerHit: 0,
};

/** Pseudo-weapon used for radial vehicle explosions. */
export const VEHICLE_EXPLOSION: MeleeDef = {
  ...VEHICLE_IMPACT,
  name: 'Explosion',
  knockback: 12,
};

export const PED_HEALTH = 60;
export const COP_HEALTH = 80;
export const PLAYER_HEALTH = 100;
export const PLAYER_ARMOUR_MAX = 100;
