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
const RAIN_COUNT = 700;

export type WeatherKind = 'clear' | 'rain' | 'fog' | 'storm';

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
  private weather: WeatherKind = 'clear';
  private weatherTimer = 75;
  private precipitation = 0;
  private cloud = 0;
  private fogAmount = 0;
  private lightningTimer = 5;
  private lightningFlash = 0;
  private rain: THREE.Points[] = [];
  private rainPositions: THREE.BufferAttribute;
  private surfaceRefreshTimer = 0;
  private wetMaterials = new Map<THREE.MeshStandardMaterial, { roughness: number; metalness: number }>();
  private readonly forcedWeather: WeatherKind | null;

  constructor(
    private scene: THREE.Scene,
    private hemi: THREE.HemisphereLight,
    private sun: THREE.DirectionalLight,
    private onThunder: () => void
  ) {
    const params = new URLSearchParams(location.search);
    const rawTime = params.get('time');
    const requestedWeather = params.get('weather');
    this.forcedWeather = requestedWeather === 'clear' || requestedWeather === 'rain' ||
      requestedWeather === 'fog' || requestedWeather === 'storm' ? requestedWeather : null;
    if (this.forcedWeather) this.weather = this.forcedWeather;
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
    const rainGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(RAIN_COUNT * 3);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 70;
      positions[i * 3 + 1] = Math.random() * 32;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 70;
    }
    this.rainPositions = new THREE.BufferAttribute(positions, 3);
    rainGeometry.setAttribute('position', this.rainPositions);
    const rainMaterial = new THREE.PointsMaterial({
      color: 0xb9d9ff,
      size: 0.075,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    for (let i = 0; i < 2; i++) {
      const rain = new THREE.Points(rainGeometry, rainMaterial);
      rain.visible = false;
      rain.frustumCulled = false;
      scene.add(rain);
      this.rain.push(rain);
    }
    this.applyEnvironment();
  }

  /** Two in-game minutes pass per real second; ?time=22 is a useful night preview. */
  update(dt: number, players: { x: number; z: number }[]): void {
    this.timeOfDay = (this.timeOfDay + dt / 30) % 24;
    this.updateWeather(dt, players);
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
    this.surfaceRefreshTimer -= dt;
    if (this.surfaceRefreshTimer <= 0) {
      this.surfaceRefreshTimer = 1;
      this.updateWetSurfaces();
    }
  }

  get darknessAmount(): number {
    return this.darkness;
  }

  get rainAmount(): number {
    return this.precipitation;
  }

  get weatherKind(): WeatherKind {
    return this.weather;
  }

  private applyEnvironment(): void {
    const sunAngle = ((this.timeOfDay - 6) / 12) * Math.PI;
    const daylight = THREE.MathUtils.smoothstep(Math.sin(sunAngle), -0.08, 0.25);
    this.darkness = 1 - daylight;
    const sky = NIGHT_COLOR.clone().lerp(DAY_COLOR, daylight).lerp(new THREE.Color(0x687387), this.cloud * 0.55);
    if (this.lightningFlash > 0) sky.lerp(new THREE.Color(0xdce8ff), this.lightningFlash * 0.7);
    this.scene.background = sky;
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.copy(NIGHT_FOG).lerp(DAY_FOG, daylight);
      this.scene.fog.color.lerp(new THREE.Color(0x758092), this.cloud * 0.5 + this.fogAmount * 0.35);
      this.scene.fog.near = THREE.MathUtils.lerp(60, 18, this.fogAmount);
      this.scene.fog.far = THREE.MathUtils.lerp(230, 105, Math.max(this.fogAmount, this.precipitation * 0.45));
    }
    this.hemi.intensity = THREE.MathUtils.lerp(0.22, 1.15, daylight) * (1 - this.cloud * 0.32) + this.lightningFlash * 1.8;
    this.sun.intensity = THREE.MathUtils.lerp(0.08, 1.7, daylight) * (1 - this.cloud * 0.7) + this.lightningFlash * 3;
    this.sun.position.set(
      Math.cos(sunAngle) * 90,
      Math.max(8, Math.sin(sunAngle) * 100),
      40
    );
  }

  private updateWeather(dt: number, players: { x: number; z: number }[]): void {
    if (!this.forcedWeather) {
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) {
        const transitions: Record<WeatherKind, WeatherKind[]> = {
          clear: ['clear', 'rain', 'fog'],
          rain: ['clear', 'storm'],
          fog: ['clear', 'rain'],
          storm: ['rain', 'clear'],
        };
        const options = transitions[this.weather];
        this.weather = options[Math.floor(Math.random() * options.length)];
        this.weatherTimer = 75 + Math.random() * 90;
      }
    }
    const targets: Record<WeatherKind, { rain: number; cloud: number; fog: number }> = {
      clear: { rain: 0, cloud: 0, fog: 0 },
      rain: { rain: 0.7, cloud: 0.72, fog: 0.25 },
      fog: { rain: 0, cloud: 0.38, fog: 1 },
      storm: { rain: 1, cloud: 1, fog: 0.5 },
    };
    const target = targets[this.weather];
    const blend = 1 - Math.exp(-dt / 8);
    this.precipitation = THREE.MathUtils.lerp(this.precipitation, target.rain, blend);
    this.cloud = THREE.MathUtils.lerp(this.cloud, target.cloud, blend);
    this.fogAmount = THREE.MathUtils.lerp(this.fogAmount, target.fog, blend);
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 5);
    if (this.weather === 'storm') {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 5 + Math.random() * 11;
        this.lightningFlash = 1;
        this.onThunder();
      }
    } else {
      this.lightningTimer = Math.min(this.lightningTimer, 4 + Math.random() * 5);
    }

    for (let i = 0; i < this.rain.length; i++) {
      const player = players[i];
      const rain = this.rain[i];
      const overlapsFirst = i > 0 && player && players[0] &&
        Math.hypot(player.x - players[0].x, player.z - players[0].z) < 30;
      rain.visible = Boolean(player && !overlapsFirst && this.precipitation > 0.04);
      if (player) rain.position.set(player.x, heightAt(player.x, player.z) + 1.5, player.z);
    }
    if (!this.rain.some((rain) => rain.visible)) return;
    const array = this.rainPositions.array as Float32Array;
    const fall = (20 + this.precipitation * 16) * dt;
    for (let i = 0; i < RAIN_COUNT; i++) {
      const y = i * 3 + 1;
      array[y] -= fall;
      if (array[y] < 0) array[y] += 32;
    }
    this.rainPositions.needsUpdate = true;
    (this.rain[0].material as THREE.PointsMaterial).opacity = 0.25 + this.precipitation * 0.48;
  }

  private updateWetSurfaces(): void {
    const seen = new Set<THREE.MeshStandardMaterial>();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!(material instanceof THREE.MeshStandardMaterial) || material.name.toLowerCase() !== 'asphalt') continue;
        seen.add(material);
        if (!this.wetMaterials.has(material)) {
          this.wetMaterials.set(material, { roughness: material.roughness, metalness: material.metalness });
        }
        const dry = this.wetMaterials.get(material)!;
        material.roughness = THREE.MathUtils.lerp(dry.roughness, 0.24, this.precipitation);
        material.metalness = THREE.MathUtils.lerp(dry.metalness, 0.12, this.precipitation);
        material.needsUpdate = true;
      }
    });
    for (const [material, dry] of this.wetMaterials) {
      if (seen.has(material)) continue;
      material.roughness = dry.roughness;
      material.metalness = dry.metalness;
      this.wetMaterials.delete(material);
    }
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
