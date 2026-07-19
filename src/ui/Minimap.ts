import { TILE } from '../core/const';
import type { AuthoredMap } from '../world/CityMap';

const MAP_COLORS: readonly [number, number, number][] = [
  [76, 74, 104],   // plaza
  [34, 37, 52],    // road
  [166, 67, 133],  // commercial
  [209, 117, 119], // residential
  [57, 126, 91],   // park
  [25, 91, 117],   // water
];

const RADIUS_METERS = 300;
const CANVAS_SIZE = 340;

/** Paint the authored byte grid once for reuse by every map view. */
export function buildMapCanvas(map: AuthoredMap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(map.width, map.height);
  for (let i = 0; i < map.grid.length; i++) {
    const color = MAP_COLORS[map.grid[i]] ?? MAP_COLORS[5];
    const offset = i * 4;
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export interface MinimapState {
  x: number;
  z: number;
  heading: number;
  suburb: string | null;
  cops: { x: number; z: number }[];
}

/** A player-up, per-viewport map rendered from the shared authored raster. */
export class Minimap {
  private root = document.createElement('div');
  private label = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private lastSuburb: string | null = null;

  constructor(
    parent: HTMLElement,
    private base: HTMLCanvasElement,
    private map: AuthoredMap
  ) {
    this.root.className = 'hud-minimap';
    this.label.className = 'hud-suburb';
    this.canvas.className = 'hud-minimap-canvas';
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.root.append(this.label, this.canvas);
    parent.appendChild(this.root);
  }

  update(state: MinimapState): void {
    if (state.suburb !== this.lastSuburb) {
      this.lastSuburb = state.suburb;
      this.label.textContent = state.suburb ?? '';
      this.label.style.display = state.suburb ? 'block' : 'none';
    }

    const ctx = this.ctx;
    const center = CANVAS_SIZE / 2;
    const radiusCells = RADIUS_METERS / TILE;
    const scale = center / radiusCells;
    const px = state.x / TILE + this.map.width / 2;
    const py = state.z / TILE + this.map.height / 2;
    const mapRotation = state.heading - Math.PI;

    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.save();
    ctx.translate(center, center);
    ctx.rotate(mapRotation);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, -px, -py);
    ctx.restore();

    const cos = Math.cos(mapRotation);
    const sin = Math.sin(mapRotation);
    for (const cop of state.cops) {
      const dx = ((cop.x - state.x) / TILE) * scale;
      const dz = ((cop.z - state.z) / TILE) * scale;
      let markerX = cos * dx - sin * dz;
      let markerY = sin * dx + cos * dz;
      const distance = Math.hypot(markerX, markerY);
      const rim = center - 18;
      if (distance > rim) {
        markerX = (markerX / distance) * rim;
        markerY = (markerY / distance) * rim;
      }
      ctx.beginPath();
      ctx.arc(center + markerX, center + markerY, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ff365f';
      ctx.shadowColor = '#ff365f';
      ctx.shadowBlur = 12;
      ctx.fill();
    }

    ctx.shadowBlur = 10;
    ctx.shadowColor = '#5ef3ff';
    ctx.fillStyle = '#eaffff';
    ctx.strokeStyle = '#102638';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(center, center - 16);
    ctx.lineTo(center - 11, center + 12);
    ctx.lineTo(center, center + 8);
    ctx.lineTo(center + 11, center + 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  dispose(): void {
    this.root.remove();
  }
}
