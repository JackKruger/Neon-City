# Neon Bay TODO

## Offline compiled Melbourne map

- [ ] Complete the full-city rollout of the versioned, offline-compiled chunk pipeline (the compiled-only runtime and 5×5 spawn pilot are implemented).
  - Treat OSM, Melbourne open data, SRTM elevation, and semantic layers as source inputs; compile terrain, roads, buildings, static props, physics, and navigation into deterministic per-chunk assets.
  - Use a manifest to define coordinate space, format versions, chunk bounds, dependencies, and compatibility. Render chunks should ultimately be optimized GLBs, with compact companion files for heightfields, simple colliders, road/navigation graphs, and gameplay metadata.
  - Correct source data before baking it: flatten complete authored building footprints with blended terrain pads, clip cross-boundary roads and buildings into every affected chunk, retain stable source IDs, and keep parked vehicles stationary on slopes.
  - The spawn-area pilot is committed and is now the only runtime map. Compile and exercise all of Melbourne before treating travel outside the pilot as supported.
  - Add small synthetic compiler tests for projection, source-tile selection, terrain sampling, shoreline treatment, building pads, road grades, quantization, chunk clipping, and manifest compatibility.

## Characters and physics

- [x] Fix players and NPCs occasionally spawning or settling halfway into the ground.
  - Audit character collider dimensions, model offsets, spawn raycasts, and uneven terrain handling.
  - Add a safe ground-snap/respawn fallback without causing visible jitter.
- [x] Allow vehicles to hit NPCs naturally instead of behaving like they struck a wall.
  - Transfer impact force to the NPC and vehicle based on speed and collision angle.
  - Trigger ragdoll above an appropriate impact threshold.
  - Keep low-speed contact from launching characters or stopping vehicles abruptly.
  - Shipped: recoverable player and carjacked-driver ragdolls use a collision-safe,
    face-up/face-down stand-up animation before returning to movement.
- [x] Add player jumping.
  - Support keyboard and gamepad input.
  - Only jump while grounded, with stable landing and slope handling.
- [x] Allow the player to move the camera independently.
  - Add mouse and right-stick orbit controls.
  - Preserve a useful chase camera while driving and recenter smoothly when requested.
  - Shipped: click-to-capture mouse orbit for player 1, per-player right-stick orbit,
    smooth V/R3 recentering, pitch limits, and chase-heading preservation on foot and in vehicles.

## Vehicles and animation

- [x] Allow NPCs to enter and exit vehicles.
  - Support choosing a vehicle, approaching a valid door, claiming a seat, and leaving safely.
  - Integrate the behavior with traffic, panic, police, and abandoned vehicles.
  - Shipped: pedestrians claim nearby abandoned cars through animated, seat-reserved door
    transitions and join the traffic graph; shaken traffic drivers exit safely, while panic,
    carjacking, burning vehicles, and ownership changes interrupt or replace the transition.
- [x] Add enter/exit vehicle animations for players and NPCs.
  - Align characters to the correct door and seat.
  - Prevent movement, collisions, or ownership changes from breaking the transition.
  - Provide a quick fallback for blocked or missing doors.
  - Shipped: players, carjacking victims, and autonomous NPCs interpolate through the nearest
    driver door and seat with collision-safe ownership claims; destroyed, moving, stolen, or
    navigation-orphaned vehicles cancel to a safe outside position.

## Combat and survival

- [x] Add a basic weapon system.
  - Start with a baseball bat and pistol.
  - Add equip/holster, aiming, attacks, damage, ammunition, hit reactions, and NPC ragdolls.
  - Connect weapon use to the wanted system and police response.
  - Shipped: fists, knife, bat, pistol, SMG, shotgun; pickups near spawn and dropped by cops;
    ~25% of pedestrians brawl back; at 2+ stars stopped police cars deploy armed on-foot cops.
- [x] Add player health and armour.
  - Track damage, armour absorption, death, and respawning.
  - Add clear health and armour bars to each player's HUD.

## World

- [x] Make streetlights emit light after dark.
  - Add or connect a time-of-day/darkness state.
  - Toggle emissive materials and nearby illumination after dark.
  - Limit active dynamic lights around players to protect performance and split-screen rendering.
  - Shipped: a shared day/night clock drives sky, fog, sun, and ambient light; emissive lamp
    heads and a fair split-screen pool of at most eight nearby point lights activate after dark.

## Economy and UI

- [x] Add a money balance for each player.
  - Display it in the HUD and provide a clear API for earning and spending money.
  - Persist the balance if save data is introduced.
- [x] Polish the UI.
  - Establish consistent typography, spacing, colors, icons, and interaction states.
  - Integrate money, health, armour, weapons, ammunition, wanted level, speed, prompts, minimaps, pause, and full-map states.
  - Verify responsive and split-screen layouts without overlaps.
  - Add clear keyboard and gamepad prompts that update with the active input method.
  - Shipped: responsive neon HUD/pause/map presentation covers money, vitals, combat, speed,
    wanted state and minimaps; interaction hints now switch between keyboard and gamepad labels.

## Additional roadmap

- [x] Add save/load support.
  - Shipped: a validated, versioned single browser slot persists player position,
    heading, money, health, armour, inventory, and ammunition, with Continue/New
    Game startup flow, pause-menu Save/Load/Delete, 60-second autosave, and safe
    on-foot restoration from vehicles. Settings remain separately persisted.
  - Owned vehicles and dynamic world state are not yet persisted.
- [ ] Expand NPC behavior and reactions.
  - Add idle activities, conversations, panic, fleeing, self-preservation, and reactions to weapons, crashes, injured NPCs, and police.
  - Keep behavior deterministic and inexpensive enough for dense crowds.
- [x] Add vehicle damage and destruction.
  - Track body and engine damage, visible deformation states, smoke/fire, occupant injuries, and eventual wrecks.
  - Add repair or replacement options so damaged vehicles fit the money system.
  - Shipped: weapon and crash damage degrade engine output and bodywork through visible crumple,
    soot, smoke, fire, and explosions; severe crashes injure occupants, wrecks eject them, and
    stopped cars can receive a paid roadside repair while replacement vehicles remain stealable.
- [x] Expand the wanted and police systems.
  - Add witnesses, crime reporting, a last-known-position search area, arrests, a busted state, and fines.
  - Scale responses from patrol cars to roadblocks and stronger units without spawning police directly in view.
  - Shipped: nearby civilians report and flee crimes, police switch between pursuit and a visible
    last-known search state, close officers can bust and fine players, on-foot arrests use a paired
    tackle and ragdoll transition, and response tiers scale to off-screen patrols, stronger armed
    officers, and three-star roadblocks.
- [ ] Add map waypoints and GPS routing.
  - Let players place and clear waypoints on the full map.
  - Display the target on minimaps and calculate a road route with distance to destination.
- [ ] Add missions and dynamic world events.
  - Build reusable objective types such as travel, chase, escape, delivery, combat, and vehicle theft.
  - Support rewards, failure states, checkpoints, and separate/co-op objectives in split-screen.
- [ ] Add pickups, shops, and usable locations.
  - Provide places to acquire weapons, ammunition, armour, health, and vehicle repairs.
  - Use clear world markers and interaction prompts without cluttering the HUD.
- [x] Add a full day/night and weather cycle.
  - Drive sky, fog, sun, streetlights, vehicle headlights, wet-road appearance, and ambient audio from shared world state.
  - Keep weather visibility and lighting fair during driving and combat.
  - Shipped: the shared clock now transitions among clear, rain, fog, and storm conditions with
    split-screen precipitation, lightning, thunder, wet asphalt, visibility-aware fog, streetlights,
    and player-vehicle headlights. `?weather=clear|rain|fog|storm` forces a preview state.
- [x] Improve vehicle and pedestrian traffic behavior.
  - Add traffic lights, yielding, overtaking, obstacle avoidance, crash recovery, and safer pedestrian crossings.
  - Prevent traffic deadlocks and provide recovery for stuck or flipped vehicles.
  - Shipped: visible alternating junction signals, vehicle and pedestrian yielding, conservative
    overtaking and obstacle steering, queued following distances, reverse recovery, automatic
    righting, and predictive pedestrian crossing checks reduce collisions and deadlocks.
- [x] Add camera collision and accessibility options.
  - Keep the camera out of buildings and terrain while preserving visibility in narrow streets.
  - Add sensitivity, inversion, camera shake, aim assistance, subtitle, and reduced-motion settings.
  - Shipped: Rapier obstruction pull-in plus persistent sensitivity, vertical inversion, aim-assist,
    subtitles, and reduced-motion controls in the pause menu. Reduced motion disables speed FOV;
    the camera does not add shake.
- [ ] Add input rebinding and controller feedback.
  - Support remappable keyboard/gamepad controls, per-player controller assignment, vibration, and disconnected-controller recovery.
- [x] Add ambient audio and combat feedback.
  - Add city ambience, footsteps, impacts, vehicle collisions, weapon sounds, and positional reactions to nearby events.
  - Shipped: procedural rain ambience, walk/run footsteps, door and repair cues, metallic
    crashes, thunder, explosions, impacts, reloads, pickups, firearms, distance falloff, subtitles,
    and nearby civilian danger reactions require no sampled assets.
- [ ] Establish performance budgets and diagnostics.
  - Shipped: an F3 developer panel tracks rolling frame/CPU/simulation/physics/render time, hitches, active actors, draw calls, triangles, GPU resources, Rapier counts, dynamic lights, and streamed chunks.
  - Add repeatable driving/combat/streaming scenarios, saved JSON baselines, and CI regression thresholds.
  - Add scalable crowd, traffic, shadow, lighting, and effects settings for lower-end hardware.
