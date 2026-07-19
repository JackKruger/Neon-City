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
  world/      city map (authored OSM grid or procedural), chunk streamer
              (merged static geometry), road graph, NPC manager
  entities/   Vehicle (raycast car physics), Character, Player, Pedestrian,
              TrafficCar, PoliceCar
  gameplay/   wanted system
  render/     split-screen viewports + chase cameras
  ui/         DOM HUD (speed, stars, prompts, pause)
scripts/
  build-map.mjs  OpenStreetMap → cell-grid importer (writes public/maps/)
```

## Rebuilding the map

`public/maps/melbourne.{bin,json,png}` are committed, so this is only
needed to change the map area or cell rules:

```bash
node scripts/build-map.mjs          # uses cached Overpass data if present
node scripts/build-map.mjs --fresh  # re-download from Overpass
```

Authoritative Victorian and City of Melbourne layers can be added through the
offline enrichment pipeline described in [`docs/open-data.md`](docs/open-data.md).

The `.png` is a preview of the generated grid (roads, water, parks,
commercial/suburban lots); tweak the `MAP` constants at the top of the
script to move the bounding box or spawn point.

Split-screen renders the one shared scene twice per frame with scissored
viewports; physics steps at a fixed 60 Hz. Audio is fully procedural
(Web Audio oscillators/noise) — engine, skids, and sirens, no samples.

The city is unbounded: the layout is a pure function of cell coordinates
(deterministic hashing, no stored map), and a chunk streamer builds
120 m chunks around each player — merged render meshes plus one fixed
physics body per chunk — at most one chunk per frame, freeing everything
more than three chunks behind. Fog distance sits just inside the loaded
ring so new chunks always appear fully fogged.
