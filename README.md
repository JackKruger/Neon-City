# Neon Bay

A browser-based, 3D, Vice-City-flavored open-world sandbox with local
split-screen co-op. Steal cars, cruise an endless procedural city, dodge
the police — all in the browser, no install.

Built with **Three.js** (rendering), **Rapier** (physics, WASM) and
**Vite + TypeScript**. All models are CC0 assets by [Kenney](https://kenney.nl)
(City Kits, Car Kit, Blocky Characters).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build: `npm run build`, then `npm run preview`.

## How to play

|                | Player 1 (keyboard)        | Gamepad (either player)     |
| -------------- | -------------------------- | --------------------------- |
| Drive / walk   | WASD                       | Left stick + RT gas, LT brake |
| Handbrake      | Space                      | A (hold)                    |
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
  world/      procedural map, chunk streamer (merged static geometry), road graph, NPC manager
  entities/   Vehicle (raycast car physics), Character, Player, Pedestrian,
              TrafficCar, PoliceCar
  gameplay/   wanted system
  render/     split-screen viewports + chase cameras
  ui/         DOM HUD (speed, stars, prompts, pause)
```

Split-screen renders the one shared scene twice per frame with scissored
viewports; physics steps at a fixed 60 Hz. Audio is fully procedural
(Web Audio oscillators/noise) — engine, skids, and sirens, no samples.

The city is unbounded: the layout is a pure function of cell coordinates
(deterministic hashing, no stored map), and a chunk streamer builds
120 m chunks around each player — merged render meshes plus one fixed
physics body per chunk — at most one chunk per frame, freeing everything
more than three chunks behind. Fog distance sits just inside the loaded
ring so new chunks always appear fully fogged.
