# Terrain Mesh: Convert Flat Ground to Real Elevation

All paths relative to `/home/jk/Desktop/claude/neoncity/Neon-City/`.

## Context

The game (Three.js + Rapier, GTA-style Melbourne sandbox) currently has a perfectly flat world: one 200km flat cuboid physics collider with its top at y=0 (`src/world/City.ts:160-164`), flat `PlaneGeometry` ground tiles per cell (`groundPlane()`, `City.ts:622-630`), and every spawn/placement hardcoding ground height 0. The goal is accurate terrain: real Melbourne elevation baked into the authored map (matching how the map is already built from OSM via `scripts/build-map.mjs`), with roads draping over hills, buildings on flattened pads, and water at sea level. Procedural map mode gets deterministic noise hills.

## Core design

- **Heights live on a global cell-corner lattice** (not per-cell). Corner `(ix, iz)` sits at world `((ix−0.5)·TILE, (iz−0.5)·TILE)`; cell `(cx, cz)` is bounded by corners `(cx..cx+1, cz..cz+1)`. Every ground plane vertex, chunk heightfield sample, and height query reads the same lattice → **no cracks at cell or chunk borders by construction**. Melbourne: 720×720 cells → 721×721 corners.
- **`heightAt(x, z)`** = bilinear interpolation over the containing corner quad; both map modes implement `cornerHeight(ix, iz)` beneath it.
- **Buildings** sit at the **min** of their cell's 4 corner heights (terrain clips slightly into wall base uphill — invisible, standard practice). **Water** plane stays flat at ~+0.015 with baked seabed (~−1.6m) under it.
- **Heights stored as a sibling binary** `public/maps/melbourne-height.bin`: 721×721 Int16 decimeters ≈ 1.04 MB raw (~300 KB gzipped), matching the existing `melbourne.bin` convention.

## Phase 1 — Height API plumbing (game stays identical; heightAt ≡ 0)

**`src/world/CityMap.ts`** — add:
- `SEA_LEVEL = 0`, `SEABED = -1.6`
- `cornerHeight(ix, iz)`, `heightAt(x, z)` (bilinear: `fx = x/TILE + 0.5`), `cellCornerHeights(cx, cz)`, `padHeight(cx, cz)` (min of 4 corners)
- Extend `AuthoredMap` with `heights: Int16Array | null` + `heightScale`; authored `cornerHeight` indexes `(ix + width/2) + (iz + height/2) * (width+1)`, out-of-grid → `SEABED`, missing heights → 0 (backward compatible).

**Replace y=0 assumptions with `heightAt`** (all no-ops in this phase):
- `src/entities/Vehicle.ts:94` — spawn: `heightAt(x,z) + wheelRadius + SUSPENSION_REST + 0.05`. Covers parked cars, traffic, police.
- `src/entities/Character.ts` — the code already has a physics-raycast `snapToGround`/`groundHeight` system (`:65,95,218-240`) that self-corrects on uneven ground, but its rise window is only 1.25m and the raycast needs chunk colliders present. Seed it with terrain height instead of 0: constructor translation (`:51`) → `heightAt(x,z) + HEIGHT/2 + 0.1`, and `lastSafeGround.set(x, 0, z)` (`:64`) → `heightAt`. `teleport()` (`:91`) already snaps; callers just pass a sane y. Covers players, pedestrians.
- `src/entities/Player.ts:122` — `exitVehicle` floor clamp → `heightAt(ex, ez) + 0.1`.
- `src/world/City.ts` placement: `building()` (`:438-448`) at `padHeight`, collider grown ~0.5m downward so no gap opens uphill; `tree()` (`:581-588`), `streetlight()` (`:570`), `yardProps()` (`:490-506`), `industrialProps()` (`:537-545`) all at `heightAt` of their base point.

**Verify:** `Neon-City:verify` — behavior identical to today.

## Phase 2 — Terrain mesh + physics, procedural hills

**Procedural corner heights** (`CityMap.ts`): value noise built on existing `cellHash` (`CityMap.ts:108-112`) — bilinear over lattice hashes with smoothstep, e.g. `10·noise(period 32, salt 200) + 3·noise(period 8, salt 201)`. Worst-case grades ~6%, drivable without a relaxation pass. Add `?map=procedural` URL param in `Game.create` to skip `loadAuthoredMap` for testing.

**Visual ground** (`City.ts`):
- `groundPlane()` (`:622-630`): keep `PlaneGeometry(TILE, TILE)` (4 verts), after positioning set each vertex `y = heightAt(vx, vz) + offset` — verts land exactly on lattice corners.
- Sand base (`:302-310`): `PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, CHUNK_TILES, CHUNK_TILES)` displaced per-vertex; doubles as seabed/beach.
- Water planes (`:596-599`): unchanged, flat.
- **Road draping**: extend `bake()` (`:633-646`) with an optional drape flag — after `applyMatrix4(matrixWorld)`, add `heightAt(vx, vz)` to each vertex y. Use for road tiles/crossings (`:251-254`) and yard paths/driveways. Skip normal recompute (no shadows, top-lit, near-flat tiles).

**Physics** (`City.ts`):
- Move the safety slab top to y = −30 (tunnelling net only).
- Per chunk in `buildChunk()`: one `RAPIER.ColliderDesc.heightfield(10, 10, heights, {x: CHUNK_SIZE, y: 1, z: CHUNK_SIZE}, HeightFieldFlags.FIX_INTERNAL_EDGES)` on the existing chunk body, 11×11 samples from the corner lattice, translated to chunk center `((c0x+4.5)·TILE, 0, (c0z+4.5)·TILE)`.
- **Rapier row/column ordering is the classic footgun**: first wire one chunk, `world.castRay` down at 4 asymmetric points, assert hit ≈ `heightAt` within ~0.3m; swap indexing if transposed.

**Verify:** `?map=procedural` — walk/drive over hills, parked cars rest on slopes, chunk streaming stable, no Rapier errors. Melbourne still flat.

## Phase 3 — DEM bake for Melbourne

**Source:** AWS Terrain Tiles skadi HGT — `https://s3.amazonaws.com/elevation-tiles-prod/skadi/S38/S38E144.hgt.gz` (SRTM 1-arcsec ~30m, raw 3601×3601 big-endian Int16, no API key, public domain + attribution). Melbourne bbox fits in this single tile; derive tile name from `bbox()` (`build-map.mjs:73`) and error if a future bbox spans tiles. Fetch/cache like the Overpass fetch (`:114-147`), respect `--fresh`.

**New `buildHeights(grid)` stage in `scripts/build-map.mjs`** (after grid finalized ~line 395):
1. Per corner: world → lat/lon (invert `toWorld`, `:58-63`), bilinear-sample HGT (voids −32768 → nearest valid).
2. Sea-level normalize: subtract mean elevation over sea-flooded cells.
3. Denoise: two 3×3 box-blur passes.
4. Water/shoreline: corners with all 4 adjacent cells `~` → pin to SEABED; BFS distance-to-water, blend land corners within 6 cells toward 0.5 and clamp land ≥ 0.3 (nothing dry below the water plane). Pinned corners frozen thereafter.
5. **Road grade relaxation**: for adjacent corner pairs touching a `#` cell, iterate (~200 passes): if `|Δh| > 0.08·TILE` (~1m/tile), pull toward mean; also constrain diagonals within road cells against twist. Road cells over water keep un-pinned corners → causeway-style river crossings.
6. Built-lot softening: cells that will host buildings (`C`, or `S` with road frontage — mirror `City.ts:262,272`) get ~10 passes pulling corners toward their mean (spread ≤ ~0.8m).
7. Quantize Int16 decimeters LE → `melbourne-height.bin`; add to `melbourne.json` meta: `"heightGrid": {"file": "melbourne-height.bin", "scale": 0.1}` plus SRTM attribution. Log min/max height and max residual road grade.

**`src/world/MapLoad.ts`**: fetch the height bin when `meta.heightGrid` exists, validate `(width+1)·(height+1)` length, set `heights`/`heightScale`; absent → `heights: null`, flat (stale builds keep working).

**Verify:** rebuild map, launch Melbourne — spawn height sane, CBD rises, St Kilda shoreline slopes into water with no dry land below the plane, Yarra crossing drivable, police chase on slopes.

## Phase 4 — Polish

- Camera: if crests occlude the follow-cam, clamp `camera.position.y ≥ heightAt(cam) + 1.2` (`src/render/Viewports.ts:34-39`).
- Update `.claude/skills/verify/SKILL.md`: teleport targets must use terrain height (consider exposing `__game.heightAt`).
- Tune MAX_GRADE, blur passes, seabed depth, shoreline blend; check vehicle downforce over crests (`Vehicle.ts:39`).
- Full verify matrix: uphill/downhill on foot, top-speed over crests, slides on grades, NPC spawns on hills, cross-city chunk churn.

## Risks

- **Rapier heightfield orientation** — mitigated by the mandatory raycast probe before building further.
- **Visual bilinear vs physics triangles** differ by cm at quad centers — absorbed by character snap-to-ground (0.45) and suspension; if feet float, switch `heightAt` to triangle-consistent interpolation.
- **Draped road tiles** shear slightly on grades ≤8% — negligible; fallback is planar road cells + rigid tilt.
- **Bridges become causeways** (bank-height roads over water, existing water-edge walls as guard rails) — accepted; true decks out of scope.
- **Payload**: +~300 KB gzipped height bin at boot.

## Verification

- After each phase: `Neon-City:verify` skill (headless build + drive).
- Phase 2: `?map=procedural`; Phase 3: rebuilt Melbourne map, drive CBD→bay, check shoreline and river crossing.
