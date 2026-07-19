# Plan: Minimap + Full-Screen Scrollable Map with Suburb Names

## Context
Neon Bay (Three.js + Rapier + Vite/TS open-world sandbox set in OSM-imported Melbourne) has no map UI at all. The user wants:
1. A **minimap** overlay during gameplay — **rotating, player-up (GTA-style)** per user choice.
2. A **full-size scrollable map** overlay with **suburb names** labelled in each area — **game keeps running while it's open** per user choice (not pause-frozen).
3. The **current suburb name displayed above the minimap**, updating live as the player moves.

No suburb data exists anywhere in the repo — it must be added to the OSM import pipeline. Everything else (top-down raster of the city, world↔grid math, per-player HUD panels, edge-triggered input plumbing) already exists and is reused.

## Key existing pieces (reuse, don't rebuild)
- `scripts/build-map.mjs` — Overpass import → 720×720 cell grid (TILE=12 m, world 8640 m, origin center, x=east/z=south). Has polygon rasterizer `fillPolygon(mask, ring)` + relation ring-stitcher `ringsOf(el)`. Writes `public/maps/melbourne.{bin,json,png}`. Cache in `.map-cache/`.
- `src/world/CityMap.ts` — `getAuthoredMap()` → `{width, height, grid: Uint8Array, ...}`, `worldToCell`, `cellAt` (out-of-grid → `'~'` water), `CODE_TO_CELL` (0 plaza, 1 road, 2 commercial, 3 residential, 4 park, 5 water). world→grid pixel: `px = round(x/12)+360`, `py = round(z/12)+360`.
- `src/world/MapLoad.ts` — `loadAuthoredMap()` fetches json+bin (from `Game.create()`, `src/core/Game.ts:53`).
- `src/ui/Hud.ts` — DOM-overlay HUD; one `<style>` template; `setPlayerCount(1|2)` builds per-player `.hud-panel` (P1 left:0/width:50%, P2 left:50% in split); `update(i, HudState)` per frame from `Game.frame()` (Game.ts:211-219); `setPaused` pattern for full-screen overlays.
- `src/core/Input.ts` — `keyEdges` + gamepad edge helper `just(i)` in `poll()`; `pendingPause`/`consumePause()` is the pattern for the new map toggle. Gamepad button 8 (Back/Select) is unused; dpad = buttons 12-15. Driving uses WASD + left stick — so map panning must use **arrows/mouse-drag/dpad** (game stays live while map is open).
- Player data: `Game.playerPositions(): {x,z}[]` (Game.ts:98-107), `Player.getHeading()` (radians), police at `player.wanted.police[]` → `cop.vehicle.body.translation()`.

## Implementation steps

### 1. Suburb data — extend `scripts/build-map.mjs`
Use **admin_level=10 boundary polygons** (Australian OSM: gazetted localities = suburbs; exact boundaries, and the polygon rasterizer already exists). Nearest-centroid from `place=suburb` nodes was rejected: inner Melbourne suburbs (CBD/Southbank/Docklands) are adjacent slivers where centroid distance misassigns exactly where players notice.

1. Add to `overpassQuery()` union: `relation["boundary"="administrative"]["admin_level"="10"](${bb});`
2. Cache invalidation: name cache file with a short hash of the query (`.map-cache/melbourne-<sha1(query)[:8]>.json`, `node:crypto`) so the query change auto-invalidates the old cache; `--fresh` still works.
3. Generalize `fillPolygon(mask, ring)` → `fillPolygon(mask, ring, value = 1)`.
4. In `main()`: collect named admin_level=10 relations (sorted by name for determinism); rasterize each into `suburbIdx = new Uint8Array(N).fill(255)` (255 = no suburb) via `ringsOf` + `fillPolygon(suburbIdx, r, i)`; drop zero-cell suburbs and remap indices (throw if >254; expect ~40-60); compute per-suburb label anchor = mean of its in-grid cell centers → world meters.
5. Write `public/maps/melbourne.suburbs.bin` (width*height bytes) — a separate file keeps `melbourne.bin` byte-compatible. Extend `melbourne.json` with `version: 2` and `suburbs: [{name, x, z}]`. Log suburb count + coverage %.
6. Run `node scripts/build-map.mjs` (needs network/Overpass) and commit the regenerated artifacts.

### 2. Runtime loading — `src/world/CityMap.ts` + `src/world/MapLoad.ts`
- `AuthoredMap` gains optional `suburbs?: {name, x, z}[]` and `suburbGrid?: Uint8Array`.
- New export `suburbNameAt(x, z): string | null` — same indexing as `cellAt`; 255/missing data → null.
- `loadAuthoredMap`: third parallel fetch of `.suburbs.bin`, **failure-tolerant** — attach only if response ok AND `meta.suburbs` is an array AND byte length === width*height (length check is the real guard; Vite can 200 missing files with index.html). Otherwise `console.warn` and continue — all UI degrades gracefully with old map files.

### 3. Input — `src/core/Input.ts`
Mirror the pause plumbing:
- `pendingMap` flags; in `poll()`: keyboard `KeyM` edge, gamepad `just(8)` (Back/Select) on claimed pads.
- `consumeMapToggle(): boolean` (same shape as `consumePause()`).
- `mapPanAxes(): {x, y}` — **arrow keys + dpad (12-15) + mouse handled in overlay**; NOT WASD/left-stick, since the game keeps running and those still drive the player.

### 4. New `src/ui/Minimap.ts`
- `buildMapCanvas(map: AuthoredMap): HTMLCanvasElement` — 720×720 canvas painted once at startup from `map.grid` via ImageData with a dark neon palette (no extra fetch, always in sync with the grid, HUD-contrast colors). Shared by minimaps + full map.
- `class Minimap { constructor(parent, base, opts); update(x, z, heading, suburb, cops); dispose() }`
  - DOM per HUD panel: `.hud-minimap` wrapper (absolute, left:14px bottom:14px), circular-masked canvas (~170 CSS px, 2× backing store, neon border), `.hud-suburb` label div **above it**.
  - Per-frame redraw (cheap: one `drawImage` crop + markers): translate/rotate by `heading` so facing is up (verify rotation sign empirically — x=east/z=south is the classic bug source), `drawImage(base, px-r, py-r, 2r, 2r, ...)` with `radiusM ≈ 300` (r = radius/12 source px), smoothing on for the upscale. Fixed up-pointing player triangle at center; red police dots (rotated with map, clamped to rim when outside radius).
  - Suburb label: write `textContent` **only when the string changes** (no per-frame DOM churn); empty → hidden.

### 5. `src/ui/Hud.ts` integration
- Extend `HudState` with `pos?: {x,z}`, `heading?: number`, `suburb?: string|null`, `cops?: {x,z}[]`.
- `Hud.setMapCanvas(base)` called once from Game after map load; `setPlayerCount` creates one `Minimap` per panel (dispose old ones on rebuild — handles P2 join; no P2-leave path exists). `update(i, state)` forwards to `minimap.update(...)` when `pos` set.
- Add `.hud-minimap` / `.hud-suburb` CSS (small caps ~14px, existing pink text-shadow idiom) to the style template; mention "M — map" in `.hud-hint` and pause text.

### 6. New `src/ui/MapOverlay.ts` — full-screen scrollable map
- `class MapOverlay { open(); close(); readonly isOpen; setPlayers(players); update(dt, panX, panY) }`
- Full-screen `.hud-map` div styled after `.hud-pause` but with **lighter backdrop** (game visibly running behind, e.g. rgba(12,4,28,.6)) and `pointer-events:auto`; window-sized canvas (handles resize + devicePixelRatio); footer hint "arrows / d-pad / drag to scroll · M to close". One shared overlay across both split-screen viewports.
- State: `center {x,z}` world meters (opens centered on P1), zoom fixed at "fit shorter window dimension" (~min(w,h)/720); optional wheel-zoom clamp as stretch goal.
- Render each frame while open (one drawImage + ~50 fillText — trivial):
  1. Base canvas with pan transform, `imageSmoothingEnabled=false` at high zoom.
  2. Suburb labels from `map.suburbs`: uppercase ~12px letterspaced `fillText` at each anchor, dark halo, skip off-screen; skip entirely if `suburbs` undefined.
  3. Player markers: heading-rotated triangles (P1 cyan, P2 orange, labelled in split-screen) — these move live since the game keeps running.
- Pan: arrows/dpad via `input.mapPanAxes()` (`center += pan * ~1800 m/s * dt`), pointer drag with `setPointerCapture`; clamp center to map bounds ±10%.

### 7. Game wiring — `src/core/Game.ts`
- Build `baseCanvas` after map load; pass to `hud.setMapCanvas` and `new MapOverlay(...)`.
- In `frame()` next to pause handling: `if (input.consumeMapToggle()) toggle mapOpen` → overlay open/close. **Do NOT gate `fixedUpdate()` on `mapOpen`** — game keeps running (user choice). Esc while map open closes the map instead of opening pause; map toggle ignored while paused.
- While open: `mapOverlay.setPlayers(...)`; `mapOverlay.update(dt, ...mapPanAxes())`.
- Per-player HUD call gains (throttle suburb lookup to on-cell-change, cache last cx/cz per player):
  - `pos`, `heading: p.getHeading()`, `cops: p.wanted.police.map(...)`
  - `suburb`: `suburbNameAt(x,z)`; if null and `cellAt` is `'~'` → `"Port Phillip Bay"`; if null on land (OSM gap) → **hold last known name** per player (also de-flickers boundary streets).

## Edge cases
- Old/missing suburb data → warning once, suburb label hidden, overlay draws no labels, minimap/map still work.
- In the bay / off-grid → "Port Phillip Bay". Unbounded land cell → last-known name held.
- P2 join mid-game → panels rebuilt, fresh Minimap per panel from shared base canvas.
- Pause + map interplay: Esc closes map first; map toggle no-op while paused.
- >254 suburbs → build script throws (won't happen at 8.6 km).

## Risks
- Overpass availability for regeneration (existing retry/endpoint rotation + cache mitigate; committed artifacts mean players never need network).
- admin_level=10 assumption — verify script log shows ~40-60 plausible names (Melbourne, Southbank, Docklands, Richmond, St Kilda...); if 0, also match `relation["place"="suburb"]`.
- Minimap rotation sign (x=east/z=south) — verify by driving north on St Kilda Rd.

## Verification (end-to-end, dev server)
1. `node scripts/build-map.mjs` → logs suburb count/coverage; `.suburbs.bin` = 518400 bytes; json has `version:2` + plausible names, |x|,|z| < 4320.
2. `npm run dev` → no suburb warning; temporarily rename `.suburbs.bin` → warning, game still runs, label hidden (restore).
3. Minimap bottom-left of each panel: drive from spawn (Flinders St) — map rotates so heading is up, streets match; wanted star → red cop dots track.
4. Suburb label: "Melbourne" at spawn → "Southbank" over Princes Bridge → "Port Phillip Bay" off a pier; no flicker along boundary roads.
5. Full map: M opens, **game keeps running behind it** (traffic moves, player markers move live); arrows/dpad/drag pan; Back (button 8) toggles on gamepad; Esc and M close; Esc doesn't also open pause.
6. Split-screen (`?p2`): two minimaps with independent positions/suburbs; full map shows both markers.
7. Perf: steady frame rate; Elements panel quiet while suburb name unchanged.

## Files
- Modify: `scripts/build-map.mjs`, `src/world/CityMap.ts`, `src/world/MapLoad.ts`, `src/ui/Hud.ts`, `src/core/Input.ts`, `src/core/Game.ts`
- Create: `src/ui/Minimap.ts`, `src/ui/MapOverlay.ts`
- Regenerate: `public/maps/melbourne.{bin,json,png}` + new `public/maps/melbourne.suburbs.bin`
