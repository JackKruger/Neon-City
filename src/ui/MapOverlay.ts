import { TILE } from '../core/const';
import type { AuthoredMap } from '../world/CityMap';

export interface MapPlayer {
  x: number;
  z: number;
  heading: number;
}

/** Full-screen map. Simulation remains live while gameplay controls are suppressed. */
export class MapOverlay {
  private events = new AbortController();
  private root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private players: MapPlayer[] = [];
  private center = { x: 0, z: 0 };
  private zoom = 0;
  private minZoom = 0;
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;
  private openState = false;
  private labelOrder: { name: string; x: number; z: number; index: number; cells: number }[] = [];

  constructor(
    private parent: HTMLElement,
    private map: AuthoredMap,
    private base: HTMLCanvasElement
  ) {
    this.root.className = 'hud-map';
    this.canvas.className = 'hud-map-canvas';
    this.ctx = this.canvas.getContext('2d')!;

    const title = document.createElement('div');
    title.className = 'hud-map-title';
    title.textContent = 'NEON BAY';
    const footer = document.createElement('div');
    footer.className = 'hud-map-footer';
    footer.textContent = 'ARROWS / D-PAD / DRAG TO SCROLL  ·  WHEEL TO ZOOM  ·  M TO CLOSE';
    this.root.append(this.canvas, title, footer);
    this.parent.appendChild(this.root);

    if (this.map.suburbs) {
      const counts = new Uint32Array(this.map.suburbs.length);
      for (const index of this.map.suburbGrid ?? []) if (index !== 255 && index < counts.length) counts[index]++;
      this.labelOrder = this.map.suburbs
        .map((suburb, index) => ({ ...suburb, index, cells: counts[index] }))
        .sort((a, b) => b.cells - a.cells || a.name.localeCompare(b.name));
    }

    const signal = this.events.signal;
    this.canvas.addEventListener('pointerdown', this.onPointerDown, { signal });
    this.canvas.addEventListener('pointermove', this.onPointerMove, { signal });
    this.canvas.addEventListener('pointerup', this.onPointerUp, { signal });
    this.canvas.addEventListener('pointercancel', this.onPointerUp, { signal });
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false, signal });
    window.addEventListener('resize', this.resize, { signal });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    if (this.openState) return;
    this.openState = true;
    this.root.style.display = 'block';
    this.parent.classList.add('hud-map-open');
    if (this.players[0]) {
      this.center.x = this.players[0].x;
      this.center.z = this.players[0].z;
    }
    this.resize();
    this.render();
  }

  close(): void {
    this.openState = false;
    this.root.style.display = 'none';
    this.parent.classList.remove('hud-map-open');
  }

  dispose(): void {
    this.events.abort();
    this.parent.classList.remove('hud-map-open');
    this.root.remove();
  }

  setPlayers(players: MapPlayer[]): void {
    this.players = players;
  }

  update(dt: number, panX: number, panY: number): void {
    if (!this.openState) return;
    const panSpeed = 1800;
    this.center.x += panX * panSpeed * dt;
    this.center.z += panY * panSpeed * dt;
    this.clampCenter();
    this.render();
  }

  private resize = (): void => {
    if (!this.openState) return;
    const rect = this.root.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.minZoom = (Math.min(rect.width, rect.height) * 0.88) / Math.max(this.map.width, this.map.height);
    this.zoom = this.zoom === 0 ? this.minZoom : Math.max(this.minZoom, this.zoom);
    this.render();
  };

  private render(): void {
    if (!this.openState) return;
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const dpr = this.canvas.width / Math.max(width, 1);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mapLeft = width / 2 - (this.center.x / TILE + this.map.width / 2) * this.zoom;
    const mapTop = height / 2 - (this.center.z / TILE + this.map.height / 2) * this.zoom;
    ctx.imageSmoothingEnabled = this.zoom < 1;
    ctx.drawImage(
      this.base,
      mapLeft,
      mapTop,
      this.map.width * this.zoom,
      this.map.height * this.zoom
    );

    if (this.labelOrder.length > 0) {
      const fontSize = Math.max(9, Math.min(12, 8 + this.zoom * 2.5));
      ctx.font = `600 ${fontSize}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
      const currentSuburb = this.suburbIndexAt(this.players[0]?.x, this.players[0]?.z);
      const labels = [...this.labelOrder].sort((a, b) => {
        if (a.index === currentSuburb) return -1;
        if (b.index === currentSuburb) return 1;
        return b.cells - a.cells;
      });
      for (const suburb of labels) {
        const point = this.worldToScreen(suburb.x, suburb.z, width, height);
        if (point.x < -80 || point.y < -20 || point.x > width + 80 || point.y > height + 20) continue;
        const name = suburb.name.toUpperCase();
        const halfWidth = ctx.measureText(name).width / 2 + 4;
        const bounds = {
          left: point.x - halfWidth,
          right: point.x + halfWidth,
          top: point.y - fontSize / 2 - 3,
          bottom: point.y + fontSize / 2 + 3,
        };
        if (bounds.left < 2 || bounds.right > width - 2 || bounds.top < 2 || bounds.bottom > height - 2) {
          continue;
        }
        if (
          occupied.some(
            (other) =>
              bounds.left < other.right &&
              bounds.right > other.left &&
              bounds.top < other.bottom &&
              bounds.bottom > other.top
          )
        ) {
          continue;
        }
        occupied.push(bounds);
        ctx.strokeStyle = 'rgba(10, 8, 23, .9)';
        ctx.fillStyle = 'rgba(255, 255, 255, .82)';
        ctx.strokeText(name, point.x, point.y);
        ctx.fillText(name, point.x, point.y);
      }
    }

    const colors = ['#63efff', '#ff8a52'];
    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      const point = this.worldToScreen(player.x, player.z, width, height);
      this.drawPlayer(point.x, point.y, player.heading, colors[i] ?? '#ffffff');
      if (this.players.length > 1) {
        ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = colors[i] ?? '#ffffff';
        ctx.strokeStyle = 'rgba(10, 8, 23, .95)';
        ctx.lineWidth = 3;
        ctx.strokeText(`P${i + 1}`, point.x, point.y + 13);
        ctx.fillText(`P${i + 1}`, point.x, point.y + 13);
      }
    }
  }

  private suburbIndexAt(x?: number, z?: number): number {
    if (x === undefined || z === undefined || !this.map.suburbGrid) return 255;
    const gx = Math.round(x / TILE) + this.map.width / 2;
    const gz = Math.round(z / TILE) + this.map.height / 2;
    if (gx < 0 || gz < 0 || gx >= this.map.width || gz >= this.map.height) return 255;
    return this.map.suburbGrid[gx + gz * this.map.width];
  }

  private worldToScreen(x: number, z: number, width: number, height: number): { x: number; y: number } {
    return {
      x: width / 2 + ((x - this.center.x) / TILE) * this.zoom,
      y: height / 2 + ((z - this.center.z) / TILE) * this.zoom,
    };
  }

  private drawPlayer(x: number, y: number, heading: number, color: string): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI - heading);
    ctx.beginPath();
    ctx.moveTo(0, -12);
    ctx.lineTo(-8, 9);
    ctx.lineTo(0, 6);
    ctx.lineTo(8, 9);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#101326';
    ctx.lineWidth = 3;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private clampCenter(): void {
    const maxX = (this.map.width * TILE * 1.1) / 2;
    const maxZ = (this.map.height * TILE * 1.1) / 2;
    this.center.x = Math.max(-maxX, Math.min(maxX, this.center.x));
    this.center.z = Math.max(-maxZ, Math.min(maxZ, this.center.z));
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragPointer = event.pointerId;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.canvas.setPointerCapture(event.pointerId);
    this.root.classList.add('is-dragging');
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointer) return;
    this.center.x -= ((event.clientX - this.dragX) / this.zoom) * TILE;
    this.center.z -= ((event.clientY - this.dragY) / this.zoom) * TILE;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.clampCenter();
    this.render();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.root.classList.remove('is-dragging');
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const worldX = this.center.x + ((mouseX - rect.width / 2) / this.zoom) * TILE;
    const worldZ = this.center.z + ((mouseY - rect.height / 2) / this.zoom) * TILE;
    const maxZoom = Math.max(6, this.minZoom * 5);
    this.zoom = Math.max(this.minZoom, Math.min(maxZoom, this.zoom * Math.exp(-event.deltaY * 0.001)));
    this.center.x = worldX - ((mouseX - rect.width / 2) / this.zoom) * TILE;
    this.center.z = worldZ - ((mouseY - rect.height / 2) / this.zoom) * TILE;
    this.clampCenter();
    this.render();
  };
}
