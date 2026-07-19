import * as THREE from 'three';
import type { WeaponId } from '../gameplay/Weapons';

/**
 * Simple procedural weapon models, matching the flat-color Kenney look.
 * Built in a natural frame: +Z points out of the grip (barrel/blade/bat
 * direction), +Y up, origin at the grip center. The rig's hand socket
 * orients this frame along the forearm.
 */

const GEO = new Map<string, THREE.BufferGeometry>();
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `b${w}:${h}:${d}`;
  let g = GEO.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    GEO.set(key, g);
  }
  return g;
}
function cylinder(rTop: number, rBottom: number, len: number): THREE.BufferGeometry {
  const key = `c${rTop}:${rBottom}:${len}`;
  let g = GEO.get(key);
  if (!g) {
    // Oriented along +Z so barrels point out of the grip.
    g = new THREE.CylinderGeometry(rTop, rBottom, len, 10);
    g.rotateX(Math.PI / 2);
    GEO.set(key, g);
  }
  return g;
}

const MATS = new Map<number, THREE.MeshStandardMaterial>();
function material(color: number, metal = false): THREE.MeshStandardMaterial {
  const key = color + (metal ? 0x1000000 : 0);
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: metal ? 0.35 : 0.75,
      metalness: metal ? 0.6 : 0.05,
    });
    MATS.set(key, m);
  }
  return m;
}

const GUNMETAL = 0x2a2d33;
const GRIP = 0x1c1c22;
const WOOD = 0xa5682a;
const BLADE = 0xc8ccd4;

function part(
  parent: THREE.Group,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshStandardMaterial,
  x: number,
  y: number,
  z: number
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

export function buildWeaponMesh(id: WeaponId): THREE.Group | null {
  if (id === 'fists') return null;
  const g = new THREE.Group();
  switch (id) {
    case 'knife': {
      part(g, box(0.03, 0.028, 0.1), material(GRIP), 0, 0, 0);
      part(g, box(0.045, 0.012, 0.02), material(GUNMETAL, true), 0, 0, 0.06); // guard
      part(g, box(0.008, 0.034, 0.2), material(BLADE, true), 0, 0, 0.17);
      break;
    }
    case 'bat': {
      part(g, cylinder(0.048, 0.024, 0.75), material(WOOD), 0, 0, 0.32);
      part(g, cylinder(0.03, 0.03, 0.03), material(WOOD), 0, 0, -0.06); // knob
      break;
    }
    case 'pistol': {
      part(g, box(0.032, 0.1, 0.045), material(GRIP), 0, -0.01, -0.01).rotation.x = 0.16;
      part(g, box(0.03, 0.046, 0.19), material(GUNMETAL, true), 0, 0.065, 0.06);
      break;
    }
    case 'smg': {
      part(g, box(0.032, 0.095, 0.045), material(GRIP), 0, -0.01, -0.01).rotation.x = 0.12;
      part(g, box(0.042, 0.07, 0.3), material(GUNMETAL, true), 0, 0.07, 0.08);
      part(g, cylinder(0.014, 0.014, 0.12), material(GUNMETAL, true), 0, 0.08, 0.28);
      part(g, box(0.028, 0.13, 0.04), material(GUNMETAL, true), 0, -0.015, 0.11).rotation.x = -0.1; // magazine
      break;
    }
    case 'shotgun': {
      part(g, box(0.04, 0.075, 0.3), material(WOOD), 0, 0.045, -0.1); // stock
      part(g, box(0.042, 0.06, 0.22), material(GUNMETAL, true), 0, 0.065, 0.1); // receiver
      part(g, cylinder(0.021, 0.021, 0.5), material(GUNMETAL, true), 0, 0.085, 0.4);
      part(g, cylinder(0.024, 0.024, 0.13), material(WOOD), 0, 0.045, 0.34); // pump
      break;
    }
  }
  return g;
}
