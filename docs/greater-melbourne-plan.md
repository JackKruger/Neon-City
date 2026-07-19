# Greater Melbourne map expansion plan

## Status

This document is the implementation plan for expanding Neon Bay from the current
fixed inner-Melbourne map to a geographically grounded, streamable Greater
Melbourne world.

It is a roadmap, not a claim that every part of metropolitan Melbourne can be
survey-perfect. The available data is strong enough for accurate terrain,
transport topology, suburbs, parcels, addresses, tram and rail alignments, and a
recognisable urban form. Exact footpath outlines, residential building shapes and
heights, lane markings, trees, kerbs, signs, parking bays, and street furniture are
not uniformly available across every council. Those gaps must be visible in source
coverage reports and filled by deterministic, evidence-based rules.

The central technical decision is:

> Keep 120 m compiled gameplay chunks, but stop representing Melbourne as one
> fixed 720×720 cell grid and one monolithic object JSON file. Store source data in
> spatially indexed regional shards, publish a small root catalog, load region
> manifests on demand, and distribute immutable region pack files containing
> chunks and level-of-detail assets.

## 1. Outcomes

The completed system must:

- cover a versioned definition of Greater Melbourne without loading the entire
  region in the browser;
- place roads, footpaths, tramlines, rail, waterways, terrain, buildings, parks,
  parcels, and named locations from traceable real-world sources where available;
- use procedural generation only as an explicit fallback, with coverage and
  confidence recorded per region and feature class;
- preserve correct left-hand vehicle lanes and coherent pedestrian, vehicle, rail,
  and tram navigation generated from the same street geometry as rendering;
- support two players being far apart without duplicating the entire world or
  breaking streaming ownership;
- keep map data completely offline at runtime;
- produce deterministic, content-addressed builds that can be validated and
  incrementally rebuilt;
- support low-detail regional views and full-map routing without loading detailed
  physics and render geometry for distant suburbs;
- retain `?map=legacy`, `?map=compiled`, and `?map=procedural` throughout the
  migration;
- make source dates, licences, attribution, fallbacks, and manual corrections
  inspectable.

## 2. Non-goals

The first Greater Melbourne release will not attempt to provide:

- survey-grade geometry for every kerb, driveway, path, building, or rail;
- photorealistic buildings or textures;
- a live connection to OSM, PTV, council, or Victorian Government services;
- real-time timetable or traffic simulation;
- enterable interiors for procedurally generated buildings;
- complete tree, sign, pole, parking, or street-furniture inventories outside
  authoritative coverage;
- simultaneous high-detail simulation of the entire metropolitan population;
- a promise that all raw source datasets can be redistributed unchanged.

## 3. Define the product boundary before scaling

“Greater Melbourne” is ambiguous in everyday use. The build must use a named,
versioned polygon rather than a hand-written latitude/longitude rectangle.

### 3.1 Recommended boundary

Use the Australian Bureau of Statistics Greater Melbourne Greater Capital City
Statistical Area (GCCSA) as the planning envelope. GCCSAs represent the functional
area of capital cities and include surrounding towns and rural land. Obtain the
official boundary from the ABS digital boundary files or spatial service:

- [ABS Greater Capital City Statistical Areas](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/main-structure-and-greater-capital-city-statistical-areas/greater-capital-city-statistical-areas)
- [ABS digital boundary files](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files)

The boundary version and its source hash must be part of the build configuration.
ASGS Edition 3 is the current source at the time this plan was written; Edition 4
was scheduled for publication in July 2026. Do not silently replace the boundary
when a new edition appears. Review it, document the delta, and produce a new
snapshot ID.

### 3.2 Coverage classes inside the boundary

The GCCSA includes large fringe and rural areas. Treat the boundary as the maximum
world envelope and classify land within it:

| Coverage class | Meaning | Required output |
| --- | --- | --- |
| `urban-core` | CBD, major activity centres, dense inner suburbs, landmarks | Full streets, paths, buildings, transit, props, physics, and navigation |
| `urban` | Continuously developed residential, commercial, and industrial land | Full transport and terrain; imported or parcel-derived buildings; selected props |
| `corridor` | Freeway, arterial, tram, rail, and mission corridors outside dense coverage | Accurate corridor geometry, terrain, structures, and navigation; simplified surroundings |
| `fringe` | Low-density edge development and small settlements | Accurate transport, terrain, water, parcels, and landmarks; procedural structures and vegetation |
| `background` | Rural, reservoir, protected, or otherwise non-priority land | Coarse terrain, water, land cover, major routes, and distant LOD only |
| `excluded` | Outside the selected boundary or intentionally inaccessible | No gameplay chunks; boundary treatment only |

The first metro release should contain all classes, but only `urban-core`, `urban`,
and `corridor` need full 120 m gameplay coverage. This makes “all of Greater
Melbourne” geographically present without pretending that empty rural land needs
CBD asset density.

### 3.3 Scale implications

The current map is 720×720 cells at 12 m, or approximately 8.64×8.64 km and 5,184
possible 120 m chunks. Its committed compiled pilot contains 25 chunks. A 10,000
km² envelope would contain roughly 694,000 120 m squares if represented densely.
The exact count must be measured from the pinned boundary and coverage mask, but
this order of magnitude proves that the current flat manifest and monolithic source
files cannot simply be enlarged.

## 4. Data inventory and source precedence

Every imported layer needs a source contract containing its licence, snapshot
date, checksum, coordinate reference system, stable-ID strategy, authority area,
quality expectations, and fallback.

### 4.1 Recommended source matrix

| Feature | Primary source | Secondary/fallback | Important limitation |
| --- | --- | --- | --- |
| World boundary | ABS Greater Melbourne GCCSA | Reviewed project override | Functional boundary includes rural land and changes between ASGS editions |
| Roads and road structures | [Vicmap Transport](https://discover.data.vic.gov.au/dataset/vicmap-transport) | OpenStreetMap, reviewed overrides | Centreline data does not guarantee exact kerb, lane, or marking geometry |
| Road names and addresses | [Vicmap Address](https://discover.data.vic.gov.au/dataset/vicmap-address) | OSM address tags | Address points are not building footprints |
| Property and parcel shape | [Vicmap Property](https://discover.data.vic.gov.au/dataset/vicmap-property) | OSM land use, deterministic lots | Ownership boundaries do not always match visible fences or usable building pads |
| Tram track and stops | [PTV datasets](https://www.ptv.vic.gov.au/footer/data-and-reporting/datasets/) | Vicmap Transport, OSM railway tags | Route shapes and physical track centrelines have different purposes |
| Train track, corridors, stations, and platforms | PTV datasets | Vicmap Transport and OSM | Multi-track detail and platform geometry vary by product |
| Footpaths and pedestrian links | Authoritative council layers where available; [City of Melbourne Pedestrian Network](https://discover.data.vic.gov.au/dataset/pedestrian-network) in its authority area | OSM footways/sidewalk tags, then inferred street cross-sections | There is no single uniformly detailed Greater Melbourne footpath polygon layer |
| Ground terrain | [Vicmap Elevation DEM 10m](https://discover.data.vic.gov.au/dataset/vicmap-elevation-dem-10m) | Vicmap 1 m DEM where covered, SRTM only as last resort | Use a ground DEM/DTM, not a surface model containing roofs and trees |
| Buildings | Council building layers in their authority areas, OSM footprints | [Vicmap Building Polygon](https://discover.data.vic.gov.au/dataset/vicmap-features-building-polygon), parcel-derived procedural buildings | Statewide Vicmap coverage is explicitly focused on larger buildings |
| Water and drainage | Vicmap Hydro and coastline products | OSM natural-water geometry | Water level, culvert, and underground drainage detail need interpretation |
| Localities and administrative areas | Vicmap Admin or ABS boundaries | OSM place nodes | Names and boundary definitions differ between products |
| Planning and land use | Vicmap Planning, Victorian land-use products, council layers | OSM land use, parcel/address density inference | Planning zones indicate permitted use, not necessarily current built form |
| Trees, canopy, parking, furniture, and public art | Council open data where available | OSM, deterministic contextual placement | Coverage and update frequency vary greatly by council |
| Speed limits and restrictions | Victorian transport/open-road data | Vicmap attributes, OSM, road-class defaults | Missing or conflicting values must be reported, not guessed silently |

### 4.2 Precedence rules

Source precedence must be evaluated per feature and per authority polygon:

1. reviewed project override with an issue/reference;
2. authoritative source that explicitly covers the location and feature type;
3. OSM feature with appropriate tags and a stable snapshot;
4. inference from related authoritative data;
5. deterministic procedural default for the coverage class;
6. omit the feature when a plausible fallback would be more misleading than useful.

Do not treat “authoritative” as automatically more geometrically detailed. For
example, PTV route geometry can establish service identity while physical PTV tram
track centrelines establish rail placement. OSM may still contain useful lane,
sidewalk, or median tags. The conflation stage should preserve all candidates and
record why one won.

### 4.3 Snapshot and licence policy

- Pin every build input by source version/date and SHA-256.
- Save retrieval URLs, query parameters, authority polygons, and licence text in a
  machine-readable source manifest.
- Never make live network calls from the browser.
- Keep raw downloads in `.map-cache`; do not commit them by default.
- Generate `ATTRIBUTION.md` and machine-readable attribution with the shipped map.
- Preserve OSM attribution and ODbL obligations separately from CC BY sources.
- Do not redistribute a raw source until its terms have been checked. Compiled
  output may still require attribution or other obligations.
- Keep per-feature provenance internally through compilation, then compact it into
  source-table indexes in shipped chunks.

## 5. Target coordinate and tiling model

### 5.1 Canonical coordinates

Use a projected metre-based coordinate system during ingestion and compilation.
GDA2020 / MGA zone 55 is the natural canonical source space for Melbourne. Store:

- canonical easting/northing as 64-bit values in build intermediates;
- a pinned game origin in canonical coordinates;
- runtime global X east and Z south in metres relative to that origin;
- source CRS and transform version in every normalized layer manifest.

Never repeatedly transform already-normalized coordinates. Transform each raw
source once into the canonical CRS, validate it against known control points, and
derive game coordinates from that normalized geometry.

### 5.2 Three spatial levels

Use three nested spatial units:

| Level | Starting size | Purpose |
| --- | ---: | --- |
| Macro tile | 9.6 km square | Root catalog grouping, low-detail terrain/land/water, routing partitions |
| Region | 2.4 km square (20×20 chunks) | Source shard, on-demand manifest, immutable distribution pack, medium LOD |
| Gameplay chunk | 120 m square (10×10 current cells) | Near render geometry, heightfield, collision, local navigation, gameplay spawns |

The exact macro/region sizes may change after benchmarks, but region dimensions
must be an integer multiple of the 120 m chunk size. Region keys and chunk keys
must be signed integer coordinates so no fixed `MIN_CHUNK`/`MAX_CHUNK` constants
are needed.

### 5.3 Sparse coverage

The root catalog lists only macro tiles intersecting the boundary. Macro tiles list
only present regions. Region manifests list only available chunk/LOD records.

Absence has an explicit meaning:

- outside boundary: inaccessible;
- background-only: regional LOD exists but no gameplay chunk;
- planned: catalog marks coverage as not yet published;
- corrupt/missing: referenced asset fails validation and produces a diagnostic.

Runtime code must not confuse intentional sparse coverage with a failed build.

### 5.4 Floating-origin readiness

Greater Melbourne distances can expose visible and physics precision problems even
though JavaScript coordinates are 64-bit. Three.js buffers and Rapier use 32-bit
values internally. First benchmark vehicles, character contacts, camera movement,
and raycasts at the furthest selected coordinates. If acceptance tolerances fail,
introduce a floating render/physics origin:

- authoritative entity positions remain in global metre coordinates;
- scene and physics coordinates are offset by a region-aligned origin;
- origin shifts occur only at safe fixed-step boundaries;
- all players share one origin, selected from their bounding box;
- split-screen players too far apart use remote simplified simulation rather than
  two unrelated physics worlds in the first implementation;
- saves, missions, navigation, and map UI never store rebased coordinates.

Treat this as a measured requirement, not an assumed rewrite.

## 6. Build pipeline architecture

The pipeline should have five explicit layers. Each layer is deterministic and can
be rebuilt independently from hashes of its inputs.

### 6.1 Layer A: acquisition

Create `scripts/map/acquire/` commands that:

- download or register user-supplied snapshots;
- validate file type, byte length where known, and checksum;
- record URL, retrieval date, published/source date, licence, CRS, authority area,
  and expected feature classes;
- support resumable downloads for large Victorian datasets;
- never overwrite a pinned snapshot without `--refresh`;
- work in a cache path such as `.map-cache/greater-melbourne/raw/<source-id>/`;
- produce `.map-cache/greater-melbourne/snapshots/<snapshot-id>.json`.

Large or manually obtained sources should be registered with a command rather than
renamed by hand. A registration should hash the file and print the expected local
layout.

### 6.2 Layer B: normalization and conflation

Create normalized vector and raster intermediates by region:

- reproject all geometry into the canonical CRS;
- repair or reject invalid polygons deterministically;
- normalize property names, enums, units, booleans, lanes, widths, surfaces, layer,
  bridge, tunnel, access, speed, and directionality;
- retain stable source IDs and source priority;
- clip features into each intersected region with a feature-specific halo;
- deduplicate identical or conflated features using stable rules;
- keep conflict records for diagnostics;
- build spatial indexes so compilation never scans all metropolitan features;
- write normalized terrain as tiled GeoTIFF/COG-compatible source tiles or an
  equivalent indexed raster format;
- write normalized vectors in a streaming, spatially indexed format such as
  FlatGeobuf or a build-only GeoPackage.

Avoid a metro-wide GeoJSON intermediate. JSON remains useful for small manifests,
fixtures, diagnostics, and reviewed overrides, not millions of production
features.

### 6.3 Layer C: semantic world model

For every region, derive reusable semantic features before rendering:

- transport corridors and junction topology;
- street cross-sections with lane, median, parking, cycle, footpath, verge, and
  tram reservations;
- bridge/tunnel/ground layer and vertical profile;
- parcel and building candidates;
- terrain constraint corridors and building pads;
- waterways, banks, coast, and water levels;
- land-cover polygons;
- transit stops, platforms, and route identifiers;
- local vehicle, pedestrian, bicycle, tram, and rail graph edges;
- stable object spawn candidates;
- source-confidence and fallback flags.

This semantic layer is the single input to render, physics, navigation, and map UI
compilers. No subsystem should independently reinterpret raw OSM or Vicmap tags.

### 6.4 Layer D: chunk and LOD compilation

Compile each 120 m gameplay chunk from its owning semantic region plus the required
halo:

- `LOD0` render mesh for terrain, streets, rails, buildings, water, and nearby
  decoration;
- NBCH companion data for terrain, colliders, local navigation, gameplay metadata,
  and compact source indexes;
- `LOD1` region mesh with simplified terrain, water, major/minor streets, rail,
  coarse buildings, and landmarks but no small props or gameplay collision;
- `LOD2` macro mesh containing terrain, coastline/water, major routes, activity
  centres, and skyline proxies;
- region and macro routing graphs;
- minimap/vector-map tiles independent of 3D LOD meshes.

Keep GLB plus versioned binary companion data initially. Change NBCH sections only
with synchronized compiler/runtime version bumps and compatibility tests.

### 6.5 Layer E: packaging and publication

Do not publish hundreds of thousands of individual files. For development, the
compiler may keep loose `.glb`/`.bin` files. For releases:

- concatenate immutable region records into pack files;
- store record offset, compressed length, uncompressed length, type, coordinates,
  and SHA-256 in the region manifest;
- target pack sizes around 32–128 MiB, splitting unusually dense regions by record
  class if necessary;
- fetch records with HTTP range requests;
- fall back to complete-pack fetch only for servers that do not support range
  requests and only when the pack is below a safe limit;
- content-address pack URLs so old clients and caches remain valid;
- publish root catalog and region manifests normally because they are small;
- keep the 5×5 spawn fixture and synthetic test maps in Git;
- put full compiled metropolitan assets in versioned release/object storage, not
  normal Git history.

GitHub Releases can host early snapshots. A static object store/CDN with byte-range
support is the long-term distribution target.

## 7. Proposed catalog and manifest hierarchy

### 7.1 Root catalog

Replace the flat full-city chunk array with a small catalog resembling:

```json
{
  "version": 2,
  "mapId": "greater-melbourne",
  "buildId": "content-hash",
  "boundary": {
    "name": "Greater Melbourne GCCSA",
    "edition": "ASGS Edition 3",
    "sourceHash": "..."
  },
  "coordinates": {
    "sourceCrs": "EPSG:7855",
    "convention": "local-x-east-z-south",
    "originEasting": 0,
    "originNorthing": 0
  },
  "chunkSize": 120,
  "regionSize": 2400,
  "macroSize": 9600,
  "required": {
    "runtimeVersion": 3,
    "containerVersion": 3,
    "catalogVersion": 2
  },
  "sourceSnapshot": "...",
  "macroTiles": [
    {
      "mx": 0,
      "mz": 0,
      "manifestUrl": "/maps/greater-melbourne/macro/0_0.<hash>.json",
      "manifestHash": "..."
    }
  ]
}
```

All numbers above are illustrative except the intended 120 m leaf chunk.

### 7.2 Macro manifest

Each macro manifest contains:

- bounds and coverage mask;
- macro LOD and routing records;
- contained region keys;
- region manifest URL/hash;
- completion state and coverage class totals;
- no leaf chunk list.

### 7.3 Region manifest

Each region manifest contains:

- bounds, coverage classes, and source-confidence summaries;
- LOD1 record;
- region routing and minimap records;
- pack URL/hash/size and range support requirement;
- leaf record index keyed by chunk coordinates;
- per-record render/data hashes, byte ranges, counts, and emptiness flags;
- compatibility versions and build dependencies.

The browser loads only root, relevant macro manifests, and nearby region manifests.

## 8. Reality reconstruction rules

### 8.1 Roads and junctions

Represent a road as a centreline/topological corridor with a resolved cross-section,
not as a single raster road cell.

Resolution order for cross-section measurements:

1. reviewed override or authoritative polygon/width;
2. explicit OSM/Vicmap lane, width, divided-road, shoulder, median, parking, cycle,
   and sidewalk attributes;
3. evidence from paired divided-road centrelines or road casement/property shape;
4. road-class and locality defaults;
5. constrained fit within available road casement/parcel space.

Each cross-section can contain, from left to right:

- property setback/verge;
- footpath;
- nature strip/tree zone;
- parking lane;
- bicycle lane or protected cycleway;
- traffic lanes;
- median or tram reservation;
- mirrored elements on the opposite side.

Junction generation must union corridor surfaces before triangulation, then derive
turn paths and crossings from the same result. Roundabouts, channelised turns,
service roads, ramps, and divided carriageways need dedicated recipes rather than
being widened generic intersections.

### 8.2 Footpaths

Footpath geometry is a confidence-tiered output:

- authoritative polygon or pedestrian network: preserve measured geometry;
- OSM path/sidewalk: use its alignment and tagged width;
- inferred sidewalk: offset from the resolved kerb/verge of eligible urban roads;
- parcel connector: add only when an address/entrance or pedestrian network justifies
  it;
- no inferred path on motorways, inaccessible corridors, rural roads, or where an
  explicit `no`/access restriction exists.

Pedestrian navigation must use the resulting path surfaces, crossings, refuge
islands, station platforms, and off-street links. It must not simply follow vehicle
road centre cells.

### 8.3 Trams and rail

Resolve each rail segment into one of:

- embedded mixed-traffic track;
- embedded reserved median track;
- grass/ballast reservation;
- side-running track;
- bridge, tunnel, depot, siding, or stop/platform segment.

PTV physical track centrelines establish the preferred alignment. Route shapes
identify services but must not replace physical geometry. Road/tram conflation must
snap compatible alignments while retaining separate source IDs.

Surface ownership must prevent texture phasing:

- one top surface owns any point in the street polygon;
- embedded rail corridors cut an opening in, or are integrated into, the road mesh;
- rails sit at a controlled physical height above their bed;
- markings use a documented decal/polygon-offset layer;
- no independent coplanar road and tram polygons are allowed;
- a compiler overlap diagnostic rejects same-layer coplanar triangles over a
  tolerance area.

Tram navigation centreline and rail render geometry come from the same resolved
track path. Stops and platforms alter the street cross-section rather than floating
on top of it.

### 8.4 Bridges, tunnels, and vertical layers

Every transport feature receives a resolved layer and vertical profile:

- `ground`, `bridge`, `tunnel`, or `structure`;
- stable level/layer integer;
- absolute or terrain-relative deck/track elevation;
- clearance envelope;
- support/abutment recipe;
- connection rules at portals and approaches.

Never force bridge decks to follow the terrain beneath them. Never flatten terrain
over tunnels. Validate crossings for expected separation and reject accidental
navigation connections between different levels.

### 8.5 Terrain

Use a ground DEM/DTM, with the 10 m Vicmap DEM as complete fallback and finer
terrain only where its coverage and quality are known. A DSM containing roofs and
trees must not be sampled as ground.

Terrain processing order:

1. mosaic and datum-normalize selected DEM sources;
2. remove voids and discontinuities at source seams;
3. sample a region-wide corner lattice with a shared one-sample halo;
4. enforce consistent coastline, waterbody, and river surfaces;
5. derive road/rail vertical profiles from terrain plus structure metadata;
6. apply narrow corridor constraints for ground-level transport;
7. create blended building pads without raising surrounding roads;
8. quantize only after all constraints;
9. compare duplicated border samples byte-for-byte across chunks and regions.

The current 12 m corner lattice can remain for LOD0 physics, but the normalized DEM
must retain enough resolution to recompile different LODs. Do not bake the only
copy of terrain into a metro-wide Int16 file.

Required terrain diagnostics include:

- raw and final min/max/percentile elevation per region;
- maximum and percentile grade by road class and rail/tram type;
- terrain penetration area for roads and paths;
- building-pad cut/fill amount;
- shoreline dry/underwater anomalies;
- region and chunk seam mismatches;
- bridge/tunnel clearance violations.

### 8.6 Buildings and parcels

Use imported footprints where coverage is authoritative or OSM geometry is valid.
Resolve height from explicit building height, levels, council data, or a locality/use
distribution in that order.

Where footprints are missing:

- derive buildable areas from property/parcel polygons;
- subtract setbacks, easements where available, driveways, vegetation constraints,
  and transport corridors;
- select deterministic building typology from planning/land use, address density,
  parcel shape, neighbourhood statistics, and coverage class;
- use stable source-derived seeds;
- preserve plausible rear access, yards, garages, and spacing;
- never place synthetic buildings inside an authoritative empty-coverage mask,
  parks, water, road casements, rail reservations, or known large facilities.

Landmarks and mission-critical buildings require reviewed footprints, height, and
orientation overrides even when a generic source exists.

### 8.7 Vegetation and street objects

Import exact objects only where the source authority and licence are clear. Outside
those areas, generate contextually:

- street trees from verge width, climate/land-cover class, and exclusion zones;
- park vegetation from canopy/land-cover density;
- lights, signs, bins, seats, and bollards from street class and activity-centre
  rules;
- parking from legal lane/lot capacity rather than unconstrained random placement.

Use density caps by LOD and split-screen performance setting. Stable seeds must
survive incremental rebuilds when unrelated source features change.

## 9. Navigation, routing, and simulation

### 9.1 Hierarchical graphs

The current compiled road network is assembled only from loaded chunks. Metro-wide
waypoints and long journeys need hierarchical routing:

- leaf graph: exact lanes, turns, crossings, local footpaths, tram tracks, and
  entrances inside/near a gameplay chunk;
- region graph: portals and costs connecting important roads, paths, stops, and
  stations across a 2.4 km region;
- macro graph: motorways, arterials, rail/tram corridors, and region portals for
  long-distance routes.

Run A* first on macro/region graphs, then refine only the route corridor into leaf
edges. Validate that every portal represented at one level has matching children
and neighbouring ownership.

### 9.2 Modal rules

Keep explicit graphs or flags for:

- left-hand vehicle lanes and legal turns;
- pedestrians and crossings;
- bicycles and shared paths;
- trams and depots;
- trains and station platforms;
- emergency/service access where gameplay needs it.

Render, collision, and each navigation graph must consume the same semantic
cross-section and vertical layer.

### 9.3 Distant simulation

Only loaded LOD0 chunks receive Rapier colliders and full NPCs. Distant traffic and
transit can be represented as deterministic graph state:

- aggregate counts and schedules per region edge;
- promote an entity to a physical NPC when its chunk becomes active;
- demote eligible unobserved entities when their chunk unloads;
- keep mission/police/player-owned entities in an authoritative lightweight state;
- never unload a player or a player-occupied vehicle;
- define ownership independently from the chunk where an entity originally
  spawned.

## 10. Runtime streaming design

### 10.1 Streaming sets

For each player position, calculate:

- LOD0 wanted chunks: retain the current starting radius of two chunks and unload
  beyond three, subject to profiling;
- LOD1 wanted regions: enough to hide LOD0 load boundaries and provide a useful
  horizon;
- LOD2 wanted macro tiles: terrain/major-route horizon and full-map continuity;
- route corridor: preload region graph and selected LOD0 chunks ahead of fast
  vehicles;
- mission pins: prevent required records from eviction.

The shared scene uses the union of both players' sets. Priority order is spawn
safety, current player chunks, predicted travel direction, second-player chunks,
mission corridor, then visual LOD.

### 10.2 Scheduler

Replace the current two-request FIFO-style pump with a budgeted scheduler:

- independent fetch, decompress/decode, main-thread attach, and disposal queues;
- abort requests that leave every player's wanted set;
- cap concurrent range requests and decoders separately;
- parse NBCH and prepare non-Three data in a worker;
- stagger collider creation and mesh attachment within frame budgets;
- cache recently used region manifests and pack byte ranges;
- expose counters for queued, fetching, decoding, loaded, failed, and evicted
  records;
- retry transient fetch failures, but fail closed on hashes or format mismatches;
- render a lower LOD until LOD0 is validated and attached.

### 10.3 Cache and versioning

- Content hashes are the cache identity.
- A new root catalog may reference unchanged region packs from an earlier release.
- Browser Cache Storage can retain immutable packs/records within a configurable
  quota.
- IndexedDB is optional only if range caching proves inadequate.
- Never mutate a published URL in place.
- Save games store a compatible map snapshot/build family and global coordinates,
  not transient chunk URLs.

## 11. Performance and size budgets

The following are initial engineering targets and must be revised using named test
hardware and measured pilot regions:

| Metric | Initial target |
| --- | ---: |
| Root catalog compressed size | ≤ 1 MiB |
| Macro manifest compressed size | ≤ 128 KiB |
| Region manifest compressed size | ≤ 256 KiB |
| Normal LOD0 chunk GLB + NBCH median | ≤ 300 KiB |
| Normal LOD0 chunk GLB + NBCH p95 | ≤ 1 MiB |
| Region pack | 32–128 MiB |
| LOD0 active chunks | Approximately 25 per nearby player, unioned for split-screen |
| Concurrent network reads | Start at 4; tune by device/network |
| Concurrent decodes | Start at 2 workers |
| Main-thread attach/dispose work | ≤ 4 ms per frame under normal streaming |
| Individual streaming hitch | No frame over 50 ms from map attachment |
| Hash/format failures | Zero tolerated in a published snapshot |
| Cross-chunk terrain seam delta | Exactly zero after quantization |
| Ground road terrain penetration | Zero above defined millimetre tolerance |
| Coplanar street/tram overlap | Zero above defined area tolerance |

Track budgets separately for single-player and worst-case split-screen players in
different regions. Dense CBD and major interchanges need their own p95/p99 reports
rather than being hidden in suburban averages.

## 12. Compiler and runtime format changes

### 12.1 Remove fixed-city assumptions

Refactor these current assumptions behind a versioned `MapDefinition`:

- `MAP_SIZE = 720`;
- `MIN_CHUNK = -36` and `MAX_CHUNK = 35`;
- compiler validation requiring exactly 72×72 chunks;
- runtime validation requiring map ID `melbourne`;
- runtime validation hardcoding only one manifest shape;
- one global `melbourne.objects.json`;
- one global height lattice and cell-layer binaries;
- a manifest containing every leaf chunk;
- chunk URLs assumed to be loose files.

The current format stays supported for the spawn pilot until catalog v2 is proven.

### 12.2 NBCH evolution

Retain existing `HGT1`, `COL1`, `NAV2`, and `GME1` semantics where possible. A
future container version may add:

- region/local coordinate origin to reduce record sizes and improve precision;
- multimodal navigation section or versioned graph flags;
- source confidence/coverage summary;
- structure/vertical-layer metadata;
- persistent spawn/state identifiers;
- external shared material or asset references.

Any change requires synchronized edits to compiler encoder, runtime parser,
validators, tests for malformed/truncated data, and regenerated fixtures.

### 12.3 Local coordinates inside records

Store chunk-local or region-local quantized coordinates in compiled records where
practical. Convert to current scene coordinates during attach. Benefits include
smaller integers, stable precision far from the origin, better compression, and
easier floating-origin support.

## 13. Validation and quality assurance

### 13.1 Synthetic tests

Add small deterministic fixtures for:

- projected-coordinate transforms and control points;
- signed region/chunk ownership and boundary edges;
- polygons and lines crossing chunk, region, and macro seams;
- source precedence and authority masks;
- invalid polygon repair/rejection;
- divided roads, roundabouts, ramps, service roads, and complex junctions;
- footpath inference/exclusion and pedestrian crossings;
- mixed-traffic, median, side-running, bridge, and reserved trams;
- road/tram surface ownership and coplanar-overlap rejection;
- bridges over roads/water/rail and tunnels below terrain;
- DEM source seams, shoreline constraints, road grades, and building pads;
- hierarchical navigation portals and long-distance route refinement;
- region pack encoding, range reads, hashes, truncation, and corruption;
- catalog/manifest/runtime compatibility rejection;
- byte-identical incremental compilation.

Tests must not require live external services.

### 13.2 Automated regional diagnostics

Every build emits machine-readable and HTML/PNG map reports for:

- source coverage by feature type and authority;
- fallback percentages by region;
- unmatched/conflicting roads and rails;
- missing street names, speeds, lane counts, and widths;
- disconnected vehicle/pedestrian/tram/rail graph components;
- dangling region/macro routing portals;
- impossible grades or turn radii;
- terrain/road/path/building intersections;
- coplanar and near-coplanar surface overlaps;
- bridge/tunnel clearance;
- duplicated or missing stable IDs;
- generated object density outliers;
- GLB/NBCH/pack sizes and compile times;
- region seam mismatches;
- attribution/source-table completeness.

Do not weaken thresholds to pass a region. Add a reviewed override, improve the
rule, or explicitly downgrade its coverage/confidence.

### 13.3 Representative acceptance regions

Maintain a small versioned suite covering different failure modes:

1. current Flinders Street/CBD spawn pilot;
2. dense CBD tram junction and platform geometry;
3. inner suburban mixed-traffic and reserved tram corridor;
4. freeway interchange with ramps, bridges, and service roads;
5. hilly eastern corridor to exercise realistic terrain and rail/road grades;
6. flat western industrial/residential growth area;
7. bayside coast, river, bridge, and low-lying terrain;
8. outer suburban activity centre and station;
9. fringe town/rural road transition;
10. two distant regions loaded simultaneously for split-screen.

Each region needs named spawn points, scripted traversal paths, expected coverage
metrics, and screenshot/geometry diagnostics.

### 13.4 Browser smoke matrix

For each milestone verify:

- cold and warm startup;
- spawn prewarm and safe terrain placement;
- walking, high-speed driving, tram/rail corridor traversal, and bridges;
- chunk/region/LOD transitions in all directions;
- two players together and far apart;
- unloading/disposal with no leaked Three.js resources or Rapier bodies;
- long-distance waypoint routing;
- offline behavior after assets are cached;
- expected diagnostics for an intentionally missing or corrupt record;
- `legacy`, `compiled`, and `procedural` regression modes.

## 14. Build and release workflow

### 14.1 Developer workflow

Proposed commands:

```sh
npm run metro:sources -- --snapshot=<id>
npm run metro:normalize -- --regions=<selector>
npm run metro:compile -- --regions=<selector> --loose
npm run metro:pack -- --regions=<selector>
npm run metro:validate -- --regions=<selector>
npm run metro:report -- --regions=<selector>
```

Selectors should support region keys, named acceptance regions, boundary polygons,
source-change sets, and route corridors. Default commands must not accidentally
start a full metropolitan rebuild.

### 14.2 Continuous integration

Use three levels:

- pull request: unit/synthetic tests, TypeScript build, deterministic spawn fixture,
  and changed acceptance regions when their cached sources are available;
- scheduled: compile and validate the complete acceptance suite plus pack/range
  tests;
- release: full normalized snapshot audit, incremental/full compile comparison,
  full catalog/pack validation, size/performance reports, licences, attribution, and
  staged browser smoke tests.

CI should cache raw and normalized sources by snapshot hash but never fetch an
unpinned “latest” source during a reproducibility test.

### 14.3 Publication

A published map release contains:

- root catalog and build provenance;
- macro and region manifests;
- content-addressed pack files;
- minimap/vector-map tiles;
- attribution and source summary;
- coverage/known-issues report;
- compatibility and minimum runtime versions;
- checksums for every public artifact.

Promote releases through `development`, `preview`, and `stable` catalog URLs. The
stable pointer is the only mutable object and should be small, reviewable, and easy
to roll back.

## 15. Phased implementation

### Phase 0: scope and measurements

Work:

- pin the initial GCCSA boundary and compute exact land/water area, bounding box,
  macro count, region count, and candidate LOD0 chunk count;
- create the coverage-class criteria and first classification mask;
- benchmark current pilot chunk sizes, compilation time, browser decode/attach,
  memory, and split-screen behavior;
- select named acceptance regions and reference hardware;
- decide the first artifact host and confirm HTTP range behavior.

Deliverables:

- versioned `MapDefinition` draft;
- measured scale/budget report;
- boundary and coverage preview;
- initial source/licence register;
- acceptance-region list.

Exit criteria:

- exact scope is reproducible from a pinned boundary;
- storage/build/runtime estimates are based on measured pilot data;
- no unresolved licence blocks for the Phase 1 test sources.

### Phase 1: remove fixed 720×720 assumptions

Work:

- introduce shared map, grid, region, and coordinate definitions;
- parameterize compiler and validators by map definition;
- replace fixed min/max chunk tests with sparse bounds/coverage tests;
- support a second synthetic multi-region map without changing Melbourne assets;
- keep manifest v1 and all current map modes working.

Likely files:

- `scripts/map/geo.mjs`;
- `scripts/map/compiled-recipes.mjs`;
- `scripts/compile-map.mjs`;
- `scripts/validate-compiled-map.mjs`;
- `src/world/CompiledFormat.ts`;
- `src/world/CompiledCity.ts`;
- new shared map-definition modules and fixtures.

Exit criteria:

- current pilot compiles byte-identically or changes only through an intentional
  versioned migration;
- a sparse synthetic map compiles, validates, streams, and rejects out-of-coverage
  requests correctly;
- all existing map tests and production build pass.

### Phase 2: snapshot registry and normalized regional sources

Work:

- implement acquisition/registration manifests;
- ingest boundary, Vicmap Transport, Vicmap DEM 10 m, PTV tracks/stops, Vicmap
  Property/Address, and a pinned OSM extract;
- implement canonical projection and control-point tests;
- write spatially indexed 2.4 km region shards with halos;
- record conflict and coverage diagnostics;
- replace the monolithic object-index path for the new map only.

Exit criteria:

- any acceptance region can be normalized without scanning all metro features;
- repeated normalization is byte-identical;
- source IDs, authority coverage, and licences survive clipping;
- invalid or missing sources produce actionable reports.

### Phase 3: catalog v2, region manifests, and loose streaming

Work:

- implement root/macro/region manifest schemas and validators;
- add hierarchical manifest loading and caching to `CompiledCity` or a replacement
  streamer;
- support sparse coverage and LOD fallback states;
- keep loose GLB/NBCH records during development;
- add prioritized fetch/decode/attach queues and diagnostics;
- verify split-screen unioning across two regions.

Exit criteria:

- startup downloads no leaf-wide manifest;
- moving between acceptance regions loads/unloads manifests and chunks safely;
- intentional background-only/excluded areas behave differently from corruption;
- current manifest v1 remains compatible.

### Phase 4: region packs and immutable distribution

Work:

- define and test a pack index/record format;
- implement deterministic pack construction and HTTP range loading;
- add hash, size, truncation, invalid-range, and retry tests;
- publish a preview snapshot outside normal Git;
- test cache behavior and rollback to a previous catalog.

Exit criteria:

- loose and packed builds decode to equivalent chunk data;
- no published region requires thousands of individual HTTP objects;
- unchanged packs are reused across incremental releases;
- a corrupt range never reaches Three.js or Rapier.

### Phase 5: authoritative terrain and vertical structures

Work:

- replace metro SRTM/DSM dependence with normalized ground DEM selection;
- create tiled terrain source and LOD products;
- implement region-seam-safe height sampling;
- resolve roads, rail, bridges, tunnels, shores, waterways, and building pads in one
  vertical model;
- add grade, penetration, seam, and clearance reports;
- benchmark far-coordinate physics and decide whether to activate floating origin.

Exit criteria:

- representative hills match the selected DTM within documented constraints;
- roads/paths do not disappear under terrain;
- bridge decks do not drape over ground and tunnels do not flatten it;
- quantized chunk/region terrain seams are exact;
- vehicles and characters remain stable at the furthest acceptance region.

### Phase 6: metro street, footpath, tram, and rail reconstruction

Work:

- build semantic corridor and junction models from normalized sources;
- implement confidence-tiered cross-sections and path inference;
- implement physical tram/rail alignment and reservation types;
- integrate surface ownership and z-fighting/overlap validation;
- produce vehicle, pedestrian, bicycle, tram, and rail graphs from the same model;
- implement reviewed overrides for complex acceptance sites.

Exit criteria:

- validation suite covers every street/tram arrangement listed in Section 13;
- no same-layer road/tram coplanar overlaps exceed tolerance;
- paths and lanes remain connected across chunk and region seams;
- left-hand navigation and legal turns are correct in acceptance regions.

### Phase 7: buildings, parcels, land cover, and contextual generation

Work:

- import authoritative/council/OSM footprints by coverage area;
- implement parcel-derived deterministic buildings and height inference;
- prevent synthetic output in authoritative empty masks;
- add land-cover-driven vegetation and street-object generation;
- create landmark override workflow;
- add density, collision, pad, and source-confidence reports.

Exit criteria:

- urban and fringe acceptance regions look structurally plausible without random
  churn between builds;
- buildings never occupy transport/water/exclusion areas;
- authoritative empty areas remain empty;
- memory/object budgets hold in CBD and suburban tests.

### Phase 8: hierarchical routing and distant state

Work:

- compile and load macro/region graphs;
- refine long routes into leaf graphs on demand;
- add multimodal portals and station/stop relationships;
- implement lightweight distant traffic/transit/entity state;
- preserve mission/player-owned entities across unloading;
- add map waypoint integration.

Exit criteria:

- routes cross the metro envelope without loading every traversed render chunk;
- graph portals have no dangling connections;
- physical/distant entity promotion is deterministic;
- two-player distant-region behavior stays within performance budgets.

### Phase 9: progressive geographic rollout

Publish in slices that exercise different systems:

1. existing inner map under catalog v2;
2. a continuous inner-core expansion;
3. one complete tram/rail/arterial corridor to an outer activity centre;
4. western flat/industrial and freeway coverage;
5. eastern hilly coverage;
6. northern and south-eastern growth corridors;
7. bayside, peninsula, fringe towns, reservoirs, and background coverage;
8. full selected boundary and catalog.

Each slice requires source report, quality report, browser smoke evidence, size and
performance comparison, known issues, and rollback catalog.

Exit criteria:

- every in-boundary region is classified and represented at its promised LOD;
- all `urban-core`, `urban`, and selected `corridor` chunks are published;
- full routing, attribution, integrity, and compatibility validation passes;
- stable remains reversible to the previous complete catalog.

### Phase 10: compiled-mode default and legacy retirement decision

Work:

- run an extended preview period;
- compare gameplay, map accuracy, load failures, and performance against legacy;
- fix saved-position, mission, map UI, and spawn edge cases;
- change default to compiled only when coverage at spawn and supported travel areas
  is complete;
- retain procedural regression mode permanently;
- retire legacy only through a separate reviewed decision.

Exit criteria:

- compiled mode meets release budgets on reference desktop and lower-tier hardware;
- no normal journey reaches missing required LOD0 without an intentional boundary;
- split-screen, offline, cold-cache, and rollback tests pass;
- known data gaps are documented rather than hidden.

## 16. Suggested first implementation slice

The first engineering slice should prove scale architecture, not attempt a large
visual expansion. Implement:

1. a `MapDefinition` that can describe current Melbourne and a sparse synthetic
   multi-region map;
2. root, macro, and region manifests for the existing 5×5 pilot;
3. loose-file hierarchical loading with the same GLB/NBCH payloads;
4. a deterministic pack containing the pilot and a byte-range reader;
5. one additional non-adjacent acceptance region compiled from pinned sources;
6. split-screen loading of the pilot and remote region simultaneously;
7. catalog, pack, corruption, sparse-coverage, and compatibility tests.

This slice answers the highest-risk questions—manifest scale, pack delivery,
far-coordinate behavior, sparse coverage, and two-player streaming—before investing
in a full data import.

## 17. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Source licences conflict or raw files cannot be redistributed | Maintain source-level provenance, keep raw cache private, publish only reviewed compiled outputs and attribution |
| Footpath/building detail varies across councils | Coverage masks, confidence tiers, OSM enrichment, deterministic inference, and explicit quality reports |
| Hundreds of thousands of files overwhelm hosting/browser | Root/macro/region manifests and immutable range-readable pack files |
| Full rebuilds become too slow | Spatial shards, per-region dependency hashes, content-addressed incremental output, scheduled release builds |
| Dense CBD chunks exceed memory or size budgets | Separate props, split dense records, instance repeated assets, simplify collision, enforce p95/p99 reports |
| Terrain creates exaggerated hills or penetrates roads | Ground DTM source, corridor-aware constraints, vertical structures, grade/penetration validation |
| Tram and road surfaces phase visually | Single surface ownership, non-coplanar layer rules, integrated embedded-track mesh, overlap validator |
| Navigation differs from rendered streets | Generate all modes from the same semantic corridor/junction model |
| Far-world physics jitters | Far-coordinate benchmark followed by region-aligned floating origin if thresholds fail |
| Two players double worst-case resource use | Unioned sets, per-stage budgets, fair priorities, remote simplified state, explicit split-screen budgets |
| Dataset refresh moves stable features and procedural seeds | Stable source IDs, conflation history, region dependency hashes, seed inputs isolated from unrelated changes |
| Boundary changes between ABS editions | Pin boundary edition/hash; treat update as a reviewed snapshot migration |
| Full metro quality becomes impossible to review manually | Representative acceptance suite, automated regional reports, confidence heatmaps, targeted overrides |

## 18. Definition of done

Greater Melbourne expansion is complete when:

- a pinned and documented boundary is fully classified;
- every in-boundary location has the promised LOD or an explicit inaccessible
  classification;
- authoritative data and deterministic fallbacks are traceable by region;
- transport, terrain, buildings, water, navigation, and gameplay metadata compile
  deterministically from regional inputs;
- startup uses a small catalog and never downloads a metro-wide leaf manifest;
- region packs stream and validate through byte ranges;
- long-distance routing works through hierarchical graphs;
- LOD0 physics and world detail load around either player without leaks or unsafe
  gaps;
- terrain, bridge/tunnel, road/path penetration, and tram/road overlap diagnostics
  pass;
- representative CBD, suburban, freeway, hilly, bayside, growth-area, and fringe
  acceptance regions pass browser tests;
- full release size, memory, frame-time, build-time, attribution, and coverage
  reports are published;
- the stable catalog can roll back without rebuilding the client;
- the current spawn pilot, procedural mode, and required legacy compatibility still
  pass until separately retired.

## 19. Immediate next actions

1. Download and pin the current ABS Greater Melbourne boundary; compute exact scale
   and preview coverage classes.
2. Add `MapDefinition` and remove fixed map bounds from compiler validation without
   changing current output.
3. Define catalog v2, macro manifest, region manifest, and pack-index schemas with
   synthetic compatibility tests.
4. Benchmark loose versus packed loading using the existing 25 compiled chunks.
5. Select and pin one remote hilly acceptance region plus its Vicmap/OSM/PTV inputs.
6. Build a source/licence registry and coverage report before adding further data.
7. Prove two-player, two-region streaming and far-coordinate physics.
8. Only then begin the full regional ingestion and geographic rollout.
