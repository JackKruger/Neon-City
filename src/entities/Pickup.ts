import * as THREE from 'three';
import type { Entity, Game } from '../core/Game';
import type { WeaponId } from '../gameplay/Weapons';
import { buildWeaponMesh } from './WeaponMeshes';

const RADIUS = 1.0;

const RING_GEO = new THREE.TorusGeometry(0.42, 0.035, 6, 24);
const RING_MAT = new THREE.MeshBasicMaterial({ color: 0x5ef3ff, transparent: true, opacity: 0.85 });

/**
 * A floating, spinning weapon that any on-foot player can walk over to
 * collect. No physics body — collection is a simple radius check.
 */
export class Pickup implements Entity {
  collected = false;
  private root = new THREE.Group();
  private spin = Math.random() * Math.PI * 2;

  constructor(
    private game: Game,
    readonly weapon: WeaponId,
    readonly ammo: number,
    x: number,
    y: number,
    z: number
  ) {
    const mesh = buildWeaponMesh(weapon);
    if (mesh) {
      mesh.rotation.x = Math.PI / 2; // lay long weapons flat while spinning
      this.root.add(mesh);
    }
    const ring = new THREE.Mesh(RING_GEO, RING_MAT);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.45;
    this.root.add(ring);
    this.root.position.set(x, y + 0.75, z);
    game.scene.add(this.root);
  }

  update(dt: number): void {
    if (this.collected) return;
    this.spin += dt * 2.2;
    this.root.rotation.y = this.spin;
    this.root.position.y += Math.sin(this.spin * 1.3) * 0.0016;
    for (const player of this.game.players) {
      if (player.dead || player.driving) continue;
      const pos = player.position();
      const dx = pos.x - this.root.position.x;
      const dz = pos.z - this.root.position.z;
      if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
      player.inventory.give(this.weapon, this.ammo);
      this.game.audio.pickupBlip();
      this.collected = true;
      this.dispose();
      return;
    }
  }

  dispose(): void {
    this.game.scene.remove(this.root);
  }
}
