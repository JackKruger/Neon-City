import type { Game } from '../core/Game';
import type { Player } from '../entities/Player';
import { PoliceCar } from '../entities/PoliceCar';
import { allRoadCells } from '../world/RoadGraph';
import { cellToWorld } from '../world/CityMap';

const STAR_THRESHOLDS = [25, 55, 100];
const EVADE_RADIUS = 45;
const EVADE_TIME = 14;
const MAX_HEAT = 130;

export class Wanted {
  heat = 0;
  stars = 0;
  private evadeTimer = 0;
  private spawnCooldown = 0;
  readonly police: PoliceCar[] = [];
  private roadCells = allRoadCells();

  constructor(
    private game: Game,
    private player: Player
  ) {}

  addHeat(amount: number): void {
    this.heat = Math.min(this.heat + amount, MAX_HEAT);
    this.evadeTimer = 0;
    this.recomputeStars();
  }

  private recomputeStars(): void {
    let s = 0;
    for (const t of STAR_THRESHOLDS) if (this.heat >= t) s++;
    this.stars = s;
  }

  update(dt: number): void {
    for (const p of this.police) p.update(dt);

    // Evasion: no police nearby for a while clears the heat.
    if (this.stars > 0) {
      const nearest = Math.min(...this.police.map((p) => p.distanceToTarget()), Infinity);
      if (nearest > EVADE_RADIUS) {
        this.evadeTimer += dt;
        if (this.evadeTimer > EVADE_TIME) {
          this.heat = 0;
          this.recomputeStars();
        }
      } else {
        this.evadeTimer = 0;
        // Sustained pursuit slowly cools heat too, so chases can end.
        this.heat = Math.max(0, this.heat - dt * 0.8);
        this.recomputeStars();
      }
    }

    // Keep police population in line with the star count.
    const want = this.stars === 0 ? 0 : this.stars;
    const active = this.police.filter((p) => !p.leaving).length;
    this.spawnCooldown -= dt;
    if (active < want && this.spawnCooldown <= 0) {
      this.spawnCooldown = 2.5;
      this.spawnPolice();
    }
    if (want === 0) {
      for (const p of this.police) p.leaving = true;
    }
    for (let i = this.police.length - 1; i >= 0; i--) {
      if (this.police[i].shouldDespawn()) {
        this.police[i].dispose();
        this.police.splice(i, 1);
      }
    }
  }

  private spawnPolice(): void {
    const pos = this.player.driving
      ? this.player.vehicle!.root.position
      : this.player.character.position();
    for (let tries = 0; tries < 14; tries++) {
      const cell = this.roadCells[Math.floor(Math.random() * this.roadCells.length)];
      const { x, z } = cellToWorld(cell.cx, cell.cz);
      const d = Math.hypot(x - pos.x, z - pos.z);
      if (d < 40 || d > 90) continue;
      const heading = Math.atan2(pos.x - x, pos.z - z);
      this.police.push(new PoliceCar(this.game, this.player, x, z, heading));
      return;
    }
  }
}
