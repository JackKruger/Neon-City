/** Fixed physics timestep (seconds). */
export const STEP = 1 / 60;

/** World size of one city tile in meters. */
export const TILE = 12;

/** Gravity (m/s^2). */
export const GRAVITY = -20;

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
