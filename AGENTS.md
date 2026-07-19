# AGENTS.md

## Project overview

Neon Bay is a browser-based, low-poly open-world game set in Melbourne. It uses TypeScript, Three.js, Rapier, and Vite. The game supports local split-screen, authored Melbourne data, an offline compiled-map pilot, and an unbounded procedural regression mode.

This file applies to the entire repository.

## Start here

- Read `README.md` for the product overview and runtime modes.
- Read `TODO.md` before expanding scope or implementing roadmap work.
- Read `docs/open-data.md` before changing Melbourne source ingestion.
- Use Node/npm versions compatible with the checked-in lockfile; install with `npm install`.
- Run the game with `npm run dev` and the production check with `npm run build`.

## Repository map

- `src/core/`: game loop, input, assets, audio, and shared constants.
- `src/world/`: map queries, legacy/procedural builders, compiled streaming, navigation, and NPC management.
- `src/entities/`: players, characters, vehicles, traffic, pedestrians, police, and pickups.
- `src/gameplay/`: combat, weapons, inventory, and wanted-state systems.
- `src/render/`: viewports, cameras, and effects.
- `src/ui/`: HUD, minimap, and full-map overlay.
- `scripts/build-map.mjs`: OSM/open-data ingestion and global Melbourne source generation.
- `scripts/compile-map.mjs`: deterministic GLB/NBCH chunk compilation.
- `scripts/map/`: reusable compiler/import helpers and map tests.
- `public/maps/`: committed global sources and compiled spawn-pilot assets.

## Development rules

- Preserve all three map modes: `?map=legacy`, `?map=compiled`, and `?map=procedural`.
- Keep split-screen behavior in mind. World state is shared, but the scene is rendered once per viewport.
- Physics runs at a fixed 60 Hz. Avoid frame-rate-dependent movement, damage, or timers.
- Dispose Three.js geometries/materials and Rapier bodies/colliders when streamed objects or entities are removed.
- Prefer deterministic seeded placement for world content. Do not introduce time, iteration-order, or network-dependent compiler output.
- Keep gameplay constants centralized where practical and avoid duplicating format or grid constants without an explicit synchronization comment.
- Maintain existing TypeScript style: explicit public types, type-only imports where appropriate, semicolons, and small focused helpers.
- Do not add runtime network dependencies for map data. All government and OSM inputs are build-time snapshots.
- Preserve source attribution and licenses when adding assets or datasets. Do not add assets without a compatible redistribution license.

## Melbourne map invariants

- World coordinates use X east, Y up, and Z south, in metres.
- Authored cells are 12 m. Compiled chunks are 10×10 cells, or 120 m.
- The Melbourne grid is 720×720 cells with chunk coordinates from -36 through 35.
- Terrain render meshes, Rapier heightfields, and height queries must use the same corner-height lattice.
- Polygon features crossing chunks must be clipped into every affected chunk and retain stable source IDs.
- Vehicle, pedestrian, and tram navigation must be generated from the same street geometry used for rendering.
- Australia uses left-hand traffic. Do not restore fixed right-hand or cell-fraction lane assumptions in compiled mode.
- Keep compiler/runtime versions and binary layouts synchronized between `scripts/map/compiled-format.mjs`, `scripts/map/compiled-recipes.mjs`, and `src/world/CompiledFormat.ts`.
- Current NBCH sections are `HGT1`, `COL1`, `NAV2`, and `GME1`. Format changes require version bumps, parser/validator changes, compatibility tests, and regenerated pilot chunks.

## Generated map assets

Treat `public/maps/` as generated-but-committed output.

- Do not hand-edit map JSON, binary files, GLBs, provenance, or previews.
- Change the importer/compiler first, then regenerate the smallest appropriate scope.
- Use `npm run map:compile -- --scope=spawn` for the committed 5×5 pilot.
- Use `npm run map:compile` or `--scope=all` only when full-city output is intentionally required.
- Use `npm run map:build` only when source ingestion must change; it performs a full-city compile and can be expensive.
- Use `node scripts/build-map.mjs --roads-only`, `--heights-only`, or `--fetch-osm-only` for targeted work when appropriate.
- Never add nondeterministic timestamps to compiled provenance.
- `public/maps/melbourne.objects.json` is already close to GitHub's 100 MB file limit. Avoid unnecessary duplication or size growth; prefer compiler-only compact formats or chunked data for future expansion.
- Before committing regenerated assets, confirm that only the intended global sources and chunk scope changed and that no stale chunk files remain.

Optional authoritative inputs live under `.map-cache/open-data` and are documented in `docs/open-data.md`. Missing inputs must be reported by the source manifest and handled by deterministic fallbacks. Do not commit `.map-cache`.

## Validation

Run checks proportional to the change:

- Gameplay/UI/runtime TypeScript change: `npm run build`.
- Map importer, geometry, terrain, or binary-format change: `npm run test:map` and `npm run build`.
- Street model or multimodal navigation change: also run `npm run map:validate-streets`.
- Regenerated compiled chunks: also run `npm run map:validate`.
- Compiler determinism or format change: run the byte-identical compiler tests and compile the spawn pilot twice if the existing test does not cover the new path.

For meaningful runtime changes, smoke-test the affected map mode in a browser. For streaming, navigation, or shared-world changes, also verify the other two modes. Check browser console errors, spawn safety, chunk loading/unloading, traffic/pedestrian movement, and split-screen if camera or viewport code changed.

## Testing expectations

- Add small synthetic fixtures for geometry and compiler edge cases instead of relying only on the full Melbourne snapshot.
- Cover chunk seams, negative coordinates, malformed/truncated binary data, source precedence, and compatibility rejection when relevant.
- Tests must not require live Overpass, government-data, or elevation downloads.
- Do not weaken validation thresholds merely to make regenerated assets pass. Explain and test intentional format or tolerance changes.

## Git hygiene

- Preserve unrelated user changes and avoid destructive Git operations.
- Keep source changes, generated map changes, and documentation consistent in the same commit when they form one feature.
- Review `git diff --check`, generated file sizes, and the exact changed chunk list before committing.
- Never commit `.map-cache`, `node_modules`, `dist`, temporary compiler staging directories, screenshots, or crash dumps.
