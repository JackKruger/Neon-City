---
name: verify
description: Build, launch, and drive Neon Bay headless to verify gameplay changes at runtime.
---

# Verifying Neon Bay

Browser game (Three.js + Rapier), no test suite. Verify by driving it
headless and inspecting the debug handle.

## Launch

```bash
npm install
npx vite --port 5173 --strictPort   # dev server, background it
```

Drive with `playwright-core` (`npm install playwright-core` in a scratch
dir; browsers are preinstalled — launch chromium with
`executablePath: '/opt/pw-browsers/chromium'`, do NOT `playwright install`).

## Debug handle

`window.__game` (set in `src/main.ts`) exposes the whole sim. Wait for it
with `page.waitForFunction(() => window.__game !== undefined)`. Useful:

- `__game.players[0]` — `.character.teleport(x, y, z)`, `.vehicle`,
  `.wanted.addHeat(120)` (3 stars, spawns police), `.wanted.police`
- `__game.npcs.traffic` / `.peds` — NPC populations (spawn within
  45–100m of a player, despawn beyond 140m; teleporting the player to
  a far corner like (-105, 0.1, -105) forces the despawn path)
- `__game.vehicles` / `__game.entities` — invariant:
  `entities.length === vehicles.length + players.length`
- `__game.city.loadedChunkCount()` — chunk streamer state; steady state is
  25 (5x5 ring per player). The map is procedural and unbounded; teleport
  anywhere and wait for the ring to refill.
- Keyboard drives P1: `page.keyboard.press('KeyE')` interact,
  `'Escape'` pause; WASD via `keyboard.down/up`.

## Gotchas

- Physics runs on a fixed 60Hz accumulator inside `setAnimationLoop`;
  headless Chromium runs rAF fine, just `waitForTimeout` real seconds.
- Headless SwiftShader renders at ~2-3 fps, so everything frame-budgeted
  (chunk builds stream at 1/frame, sim time advances at dt cap 0.1s/frame)
  runs ~20x slower than wall clock. Use `waitForFunction` on game state
  with 60-120s timeouts instead of fixed sleeps; a smaller viewport helps.
- Console shows one harmless 404 (favicon). Any Rapier/wasm pageerror
  is a real bug — a freed body being updated crashes every frame.
- URL params: `?nofog`, `?testcar`, `?p2`, `?pos=x,y,z&look=x,y,z`.
