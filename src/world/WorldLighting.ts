import * as THREE from 'three';
import { PALETTE, TILE } from '../core/const';
import { heightAt, worldToCell } from './CityMap';
import { streetlightPlacements } from './City';

const MAX_DYNAMIC_LIGHTS = 8;
const SEARCH_RADIUS_CELLS = 5;
const DAY_COLOR = new THREE.Color(PALETTE.sky);
const NIGHT_COLOR = new THREE.Color(PALETTE.night);
const DAY_FOG = new THREE.Color(PALETTE.fogColor);
const NIGHT_FOG = new THREE.Color(0x120c25);

interface Lamp {
  light: THREE.PointLight;
  bulb: THREE.Mesh;
}

/** Shared clock, sky lighting, and a split-screen-safe pool of nearby lamps. */
export class WorldLighting {
  private timeOfDay: number;
  private lamps: Lamp[] = [];
  private refreshTimer = 0;
  private darkness = 0;

  constructor(
    private scene: THREE.Scene,
    private hemi: THREE.HemisphereLight,
    private sun: THREE.DirectionalLight
  ) {
    const rawTime = new URLSearchParams(location.search).get('time');
    const requested = rawTime === null ? Number.NaN : Number(rawTime);
    const now = new Date();
    this.timeOfDay = Number.isFinite(requested)
      ? ((requested % 24) + 24) % 24
      : now.getHours() + now.getMinutes() / 60;
    for (let i = 0; i < MAX_DYNAMIC_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffd39b, 0, 25, 2);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffe4b8 })
      );
      light.add(bulb);
      light.visible = false;
      scene.add(light);
      this.lamps.push({ light, bulb });
    }
    this.applyEnvironment();
  }

  /** Two in-game minutes pass per real second; ?time=22 is a useful night preview. */
  update(dt: number, players: { x: number; z: number }[]): void {
    this.timeOfDay = (this.timeOfDay + dt / 30) % 24;
    this.applyEnvironment();
    this.refreshTimer -= dt;
    if (this.refreshTimer <= 0) {
      this.refreshTimer = 0.25;
      this.placeNearbyLamps(players);
    }
    const intensity = 52 * THREE.MathUtils.smoothstep(this.darkness, 0.35, 0.9);
    for (const lamp of this.lamps) {
      lamp.light.intensity = intensity;
      lamp.bulb.visible = intensity > 0.5;
    }
  }

  private applyEnvironment(): void {
    const sunAngle = ((this.timeOfDay - 6) / 12) * Math.PI;
    const daylight = THREE.MathUtils.smoothstep(Math.sin(sunAngle), -0.08, 0.25);
    this.darkness = 1 - daylight;
    const sky = NIGHT_COLOR.clone().lerp(DAY_COLOR, daylight);
    this.scene.background = sky;
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(NIGHT_FOG).lerp(DAY_FOG, daylight);
    }
    this.hemi.intensity = THREE.MathUtils.lerp(0.22, 1.15, daylight);
    this.sun.intensity = THREE.MathUtils.lerp(0.08, 1.7, daylight);
    this.sun.position.set(
      Math.cos(sunAngle) * 90,
      Math.max(8, Math.sin(sunAngle) * 100),
      40
    );
  }

  private placeNearbyLamps(players: { x: number; z: number }[]): void {
    if (this.darkness < 0.25) {
      for (const lamp of this.lamps) lamp.light.visible = false;
      return;
    }
    const candidates: { x: number; z: number; distance: number }[] = [];
    const seen = new Set<string>();
    for (const player of players) {
      const center = worldToCell(player.x, player.z);
      const local: { x: number; z: number; distance: number }[] = [];
      for (let dz = -SEARCH_RADIUS_CELLS; dz <= SEARCH_RADIUS_CELLS; dz++) {
        for (let dx = -SEARCH_RADIUS_CELLS; dx <= SEARCH_RADIUS_CELLS; dx++) {
          for (const placement of streetlightPlacements(center.cx + dx, center.cz + dz)) {
            const distance = Math.hypot(placement.bulbX - player.x, placement.bulbZ - player.z);
            if (distance <= SEARCH_RADIUS_CELLS * TILE) {
              local.push({ x: placement.bulbX, z: placement.bulbZ, distance });
            }
          }
        }
      }
      local.sort((a, b) => a.distance - b.distance);
      for (const candidate of local.slice(0, Math.ceil(MAX_DYNAMIC_LIGHTS / Math.max(1, players.length)))) {
        const key = `${candidate.x.toFixed(2)},${candidate.z.toFixed(2)}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push(candidate);
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < this.lamps.length; i++) {
      const candidate = candidates[i];
      const lamp = this.lamps[i].light;
      lamp.visible = Boolean(candidate);
      if (candidate) lamp.position.set(candidate.x, heightAt(candidate.x, candidate.z) + 5.65, candidate.z);
    }
  }
}
