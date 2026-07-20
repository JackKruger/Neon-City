/** Fixed physics timestep (seconds). */
export const STEP = 1 / 60;

/** World size of one city tile in meters. */
export { TILE_SIZE as TILE } from '../world/MapContract';

/** Gravity (m/s^2). */
export const GRAVITY = -20;

/**
 * Living on-foot characters are detected by gameplay code instead of acting
 * as immovable solver contacts against vehicles. Other collision pairs retain
 * Rapier's default all-groups behavior.
 */
const VEHICLE_GROUP = 0x0004;
const PEDESTRIAN_GROUP = 0x0008;
export const VEHICLE_COLLISION_GROUPS =
  ((VEHICLE_GROUP << 16) | (0xffff & ~PEDESTRIAN_GROUP)) >>> 0;
export const PEDESTRIAN_COLLISION_GROUPS =
  ((PEDESTRIAN_GROUP << 16) | (0xffff & ~VEHICLE_GROUP)) >>> 0;

/** Stealable civilian car models (also used for parked and traffic cars). */
export const CIVILIAN_CARS = [
  'cars/sedan',
  'cars/sedan-sports',
  'cars/hatchback-sports',
  'cars/suv',
  'cars/suv-luxury',
  'cars/taxi',
  'cars/van',
  'cars/truck',
];

export const PALETTE = {
  sky: 0xffb4a2,
  fogColor: 0xf7a8b8,
  water: 0x2ec4b6,
  sand: 0xf4e3b2,
  pavement: 0x9a93a8,
  asphalt: 0x4e5560,
  grass: 0x7ec850,
  night: 0x1a1030,
};
