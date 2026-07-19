# Neon Bay TODO

## Offline compiled Melbourne map

- [ ] Replace runtime city construction with a versioned, offline-compiled chunk pipeline.
  - Treat OSM, Melbourne open data, SRTM elevation, and semantic layers as source inputs; compile terrain, roads, buildings, static props, physics, and navigation into deterministic per-chunk assets.
  - Use a manifest to define coordinate space, format versions, chunk bounds, dependencies, and compatibility. Render chunks should ultimately be optimized GLBs, with compact companion files for heightfields, simple colliders, road/navigation graphs, and gameplay metadata.
  - Correct source data before baking it: flatten complete authored building footprints with blended terrain pads, clip cross-boundary roads and buildings into every affected chunk, retain stable source IDs, and keep parked vehicles stationary on slopes.
  - Build and verify one representative spawn-area chunk through both the current and compiled paths before compiling all of Melbourne. Keep `?map=procedural` as a lightweight development and regression mode.
  - Add small synthetic compiler tests for projection, source-tile selection, terrain sampling, shoreline treatment, building pads, road grades, quantization, chunk clipping, and manifest compatibility.

## Characters and physics

- [x] Fix players and NPCs occasionally spawning or settling halfway into the ground.
  - Audit character collider dimensions, model offsets, spawn raycasts, and uneven terrain handling.
  - Add a safe ground-snap/respawn fallback without causing visible jitter.
- [x] Allow vehicles to hit NPCs naturally instead of behaving like they struck a wall.
  - Transfer impact force to the NPC and vehicle based on speed and collision angle.
  - Trigger ragdoll above an appropriate impact threshold.
  - Keep low-speed contact from launching characters or stopping vehicles abruptly.
- [x] Add player jumping.
  - Support keyboard and gamepad input.
  - Only jump while grounded, with stable landing and slope handling.
- [ ] Allow the player to move the camera independently.
  - Add mouse and right-stick orbit controls.
  - Preserve a useful chase camera while driving and recenter smoothly when requested.

## Vehicles and animation

- [ ] Allow NPCs to enter and exit vehicles.
  - Support choosing a vehicle, approaching a valid door, claiming a seat, and leaving safely.
  - Integrate the behavior with traffic, panic, police, and abandoned vehicles.
- [ ] Add enter/exit vehicle animations for players and NPCs.
  - Align characters to the correct door and seat.
  - Prevent movement, collisions, or ownership changes from breaking the transition.
  - Provide a quick fallback for blocked or missing doors.

## Combat and survival

- [ ] Add a basic weapon system.
  - Start with a baseball bat and pistol.
  - Add equip/holster, aiming, attacks, damage, ammunition, hit reactions, and NPC ragdolls.
  - Connect weapon use to the wanted system and police response.
- [ ] Add player health and armour.
  - Track damage, armour absorption, death, and respawning.
  - Add clear health and armour bars to each player's HUD.

## World

- [ ] Make streetlights emit light after dark.
  - Add or connect a time-of-day/darkness state.
  - Toggle emissive materials and nearby illumination after dark.
  - Limit active dynamic lights around players to protect performance and split-screen rendering.

## Economy and UI

- [x] Add a money balance for each player.
  - Display it in the HUD and provide a clear API for earning and spending money.
  - Persist the balance if save data is introduced.
- [ ] Polish the UI.
  - Establish consistent typography, spacing, colors, icons, and interaction states.
  - Integrate money, health, armour, weapons, ammunition, wanted level, speed, prompts, minimaps, pause, and full-map states.
  - Verify responsive and split-screen layouts without overlaps.
  - Add clear keyboard and gamepad prompts that update with the active input method.

## Additional roadmap

- [ ] Add save/load support.
  - Persist player positions, money, health, armour, inventory, owned vehicles, and settings.
  - Version save data so future updates can migrate older saves safely.
- [ ] Expand NPC behavior and reactions.
  - Add idle activities, conversations, panic, fleeing, self-preservation, and reactions to weapons, crashes, injured NPCs, and police.
  - Keep behavior deterministic and inexpensive enough for dense crowds.
- [ ] Add vehicle damage and destruction.
  - Track body and engine damage, visible deformation states, smoke/fire, occupant injuries, and eventual wrecks.
  - Add repair or replacement options so damaged vehicles fit the money system.
- [ ] Expand the wanted and police systems.
  - Add witnesses, crime reporting, a last-known-position search area, arrests, a busted state, and fines.
  - Scale responses from patrol cars to roadblocks and stronger units without spawning police directly in view.
- [ ] Add map waypoints and GPS routing.
  - Let players place and clear waypoints on the full map.
  - Display the target on minimaps and calculate a road route with distance to destination.
- [ ] Add missions and dynamic world events.
  - Build reusable objective types such as travel, chase, escape, delivery, combat, and vehicle theft.
  - Support rewards, failure states, checkpoints, and separate/co-op objectives in split-screen.
- [ ] Add pickups, shops, and usable locations.
  - Provide places to acquire weapons, ammunition, armour, health, and vehicle repairs.
  - Use clear world markers and interaction prompts without cluttering the HUD.
- [ ] Add a full day/night and weather cycle.
  - Drive sky, fog, sun, streetlights, vehicle headlights, wet-road appearance, and ambient audio from shared world state.
  - Keep weather visibility and lighting fair during driving and combat.
- [ ] Improve vehicle and pedestrian traffic behavior.
  - Add traffic lights, yielding, overtaking, obstacle avoidance, crash recovery, and safer pedestrian crossings.
  - Prevent traffic deadlocks and provide recovery for stuck or flipped vehicles.
- [ ] Add camera collision and accessibility options.
  - Keep the camera out of buildings and terrain while preserving visibility in narrow streets.
  - Add sensitivity, inversion, camera shake, aim assistance, subtitle, and reduced-motion settings.
- [ ] Add input rebinding and controller feedback.
  - Support remappable keyboard/gamepad controls, per-player controller assignment, vibration, and disconnected-controller recovery.
- [ ] Add ambient audio and combat feedback.
  - Add city ambience, footsteps, impacts, vehicle collisions, weapon sounds, and positional reactions to nearby events.
- [ ] Establish performance budgets and diagnostics.
  - Track frame time, physics cost, active NPCs, draw calls, dynamic lights, and streamed chunks.
  - Add scalable crowd, traffic, shadow, lighting, and effects settings for split-screen and lower-end hardware.
