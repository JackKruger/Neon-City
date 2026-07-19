# Neon Bay

A browser-based, 3D, Vice-City-flavored open-world sandbox with local
split-screen co-op. Steal cars, cruise the streets of **Melbourne**, dodge
the police — all in the browser, no install.

The city is a fixed ~8.6 × 8.6 km map of inner Melbourne — the Hoddle
Grid, the Yarra, Albert Park, Docklands, St Kilda and Port Phillip Bay —
imported from OpenStreetMap onto the game's tile grid. You spawn outside
Flinders Street Station.

Built with **Three.js** (rendering), **Rapier** (physics, WASM) and
**Vite + TypeScript**. All models are CC0 assets by [Kenney](https://kenney.nl)
(City Kits, Car Kit, Blocky Characters). Map data ©
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright),
licensed under ODbL.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build: `npm run build`, then `npm run preview`.

## Roadmap

Current features and fixes are tracked in [TODO.md](TODO.md).

## How to play

|                | Player 1 (keyboard)        | Gamepad (either player)     |
| -------------- | -------------------------- | --------------------------- |
| Drive / walk   | WASD                       | Left stick + RT gas, LT brake |
| Jump / handbrake | Space                    | A                           |
| Sprint         | Shift                      | A (hold)                    |
| Enter/exit car | E                          | Y                           |
| Pause          | Esc                        | Start                       |

- **Player 2**: press **Start** on a second gamepad to join — the screen
  splits vertically.
- A gamepad can also drive Player 1: press any face button on an
  unclaimed pad.
- Run over pedestrians or ram traffic and your **wanted stars** rise;
  police cruisers will hunt you down. Shake them off (stay >45 m away)
  and the heat clears.
- Crashed traffic cars get abandoned by their drivers — free wheels.

## Project layout

```
src/
  core/       game loop, input (keyboard + gamepads), asset cache, audio
  world/      global map queries, legacy/procedural builder, compiled chunk
              streamer, road graph, NPC manager
  entities/   Vehicle (raycast car physics), Character, Player, Pedestrian,
              TrafficCar, PoliceCar
  gameplay/   wanted system
  render/     split-screen viewports + chase cameras
  ui/         DOM HUD (speed, stars, prompts, pause)
scripts/
  build-map.mjs    source ingestion (writes global data under public/maps/)
  compile-map.mjs  deterministic GLB/NBCH Melbourne chunk compiler
```

## Rebuilding the map

The global source snapshot and compiled spawn pilot are committed. Source
ingestion and render/physics/navigation compilation are separate commands:

```bash
npm run map:compile -- --scope=spawn # deterministic 5x5 spawn pilot
npm run map:compile                  # compile all 72x72 Melbourne chunks
npm run map:validate                 # validate hashes, formats, bounds and navigation
npm run map:build                    # source ingest plus full compilation
```

Use `node scripts/build-map.mjs --fresh` to refresh Overpass or
`node scripts/build-map.mjs --heights-only` to rebake cached SRTM terrain.

Authoritative Victorian and City of Melbourne layers can be added through the
offline enrichment pipeline described in [`docs/open-data.md`](docs/open-data.md).

The `.png` is a preview of the generated grid (roads, water, parks,
commercial/suburban lots); tweak the `MAP` constants at the top of the
script to move the bounding box or spawn point.

Split-screen renders the one shared scene twice per frame with scissored
viewports; physics steps at a fixed 60 Hz. Audio is fully procedural
(Web Audio oscillators/noise) — engine, skids, and sirens, no samples.

Map modes are explicit: `?map=compiled` streams offline Melbourne GLB/NBCH
pairs, `?map=legacy` runs the authored browser-side builder, and
`?map=procedural` keeps the unbounded deterministic sandbox. The default is
legacy while the committed compiled snapshot is limited to the spawn pilot.
Both streamers own 120 m chunks and unload resources beyond a hysteresis ring.
