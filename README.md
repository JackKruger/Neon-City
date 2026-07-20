# Neon Bay

A browser-based, 3D, Vice-City-flavored open-world sandbox. Steal cars,
cruise the streets of **Melbourne**, dodge
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

Run all runtime and compiler tests with `npm test`, or only the TypeScript
runtime suite with `npm run test:runtime`.

## Roadmap

Current features and fixes are tracked in [TODO.md](TODO.md).

The architecture, data sources, quality tiers, rollout phases, and release criteria
for expanding the world across Greater Melbourne are documented in
[`docs/greater-melbourne-plan.md`](docs/greater-melbourne-plan.md).

## How to play

|                | Keyboard                   | Gamepad                     |
| -------------- | -------------------------- | --------------------------- |
| Drive / walk   | WASD                       | Left stick + RT gas, LT brake |
| Jump / handbrake | Space                    | A                           |
| Orbit camera   | Mouse (click game to capture) | Right stick              |
| Recenter camera | V                         | R3                          |
| Sprint         | Shift                      | A (hold)                    |
| Enter/exit vehicle | E                      | Y                           |
| Helicopter up/down | Space / Shift          | A / B                       |
| Pause          | Esc                        | Start                       |
| Test menu (development) | F4                 | —                           |

- A gamepad can take over from the keyboard: press any face button on an
  unclaimed pad.
- Run over pedestrians or ram traffic and your **wanted stars** rise;
  police cruisers will hunt you down. Shake them off (stay >45 m away)
  and the heat clears.
- Crashed traffic cars get abandoned by their drivers — free wheels.
- Melbourne rail and tram alignments are compiled into the spawn pilot with solid ambient trains and trams, real stops, deterministic service intervals, and road traffic that yields to trams.
- Every weapon and a flyable helicopter spawn nearby. Helicopters use W/S
  for forward/back, A/D to yaw, and Space/Shift (A/B) to climb/descend.
  Press E/Y to jump out in flight and enter a physics ragdoll; hard landings
  deal damage and sufficiently severe falls are fatal. Survivors use an
  animated ground recovery instead of snapping upright.
- The world clock follows local time when a session starts and then advances at
  two in-game minutes per real second. Use `?time=22` to preview night lighting;
  `?weather=clear`, `rain`, `fog`, or `storm` locks a weather preview.
- Civilian drivers leave damaged cars, pedestrians can claim abandoned vehicles,
  and stopped damaged cars can be repaired with R / X for $75.
- Crimes need a nearby civilian or police witness. Breaking contact starts a
  last-known-position search; close police can arrest and fine the player,
  with on-foot officers tackling the player into the busted state.
- Camera sensitivity, inversion, reduced motion, aim assistance, and subtitles
  can be changed from the pause menu and persist in the browser.
- A single versioned save slot is stored in the browser. A valid slot adds a
  Continue / New Game screen at startup; the pause menu provides Save, Load,
  and Delete Save controls. The game also autosaves every 60 seconds of active
  play and when the page is hidden, whenever the player is in a safe state.
- Saves restore the player on foot with position, heading, health, armour,
  money, weapons, and ammunition. Owned vehicles and other dynamic world state
  are not yet persisted; saving while driving restores on foot at that surface.

## Project layout

```
src/
  core/       game loop, input (keyboard + gamepads), asset cache, audio
  world/      global map queries, compiled chunk streamer, road graph, NPC manager
  entities/   Vehicle (raycast car physics), Character, Player, Pedestrian,
              TrafficCar, PoliceCar
  gameplay/   wanted system
  render/     viewport, chase camera, and effects
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

Physics steps at a fixed 60 Hz. Audio is fully procedural
(Web Audio oscillators/noise) — engine, skids, and sirens, no samples.

The runtime streams offline Melbourne GLB/NBCH pairs exclusively. The committed
compiled snapshot is currently a 5×5 spawn pilot, so travel beyond that area will
not have detailed world chunks until the full-city compile is published. Compiled
chunks are 120 m and unload beyond a hysteresis ring.

Development builds show rolling performance diagnostics while playing. Press F3
to toggle the panel. F4 opens a test menu with time and weather locks,
invincibility, wanted-level controls, vitals, arsenal, and vehicle repair. Cheat
state is session-only and is not written to saves. Production builds can opt in
to both developer panels with `?dev`.
