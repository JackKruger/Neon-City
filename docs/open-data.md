# Melbourne open-data map build

The normal game uses committed map assets and does not call government services at runtime. The importer enriches the OSM grid when source exports are present in `.map-cache/open-data`. GeoJSON is preferred; a source may instead use the same basename with `.shp` plus its `.prj`, `.csv`, or pipe-delimited `.psv`.

Run `node scripts/build-map.mjs --list-open-data` for the complete filename list. The main local inputs are:

- `vicmap-transport.geojson`, `speed-zones.geojson`, and `vicmap-planning.geojson`
- `vicmap-address.geojson` or the fallback `gnaf-address.geojson`
- `geoscape-localities.geojson` or the fallback `abs-localities.geojson`
- `clue-floor-space.geojson` containing block or small-area geometry
- `footpaths.geojson` containing City of Melbourne footpath polygons
- `tram-tracks.geojson` containing PTV tram track centrelines (optional; OSM tram tracks remain the fallback)
- `street-overrides.geojson` containing reviewed polygon or centreline corrections; set `mode`, `surface`, `role`, `width`, and normal OSM-style lane tags in feature properties
- `melbourne-dsm.tif`, or set `MELBOURNE_DSM_PATH` to one GeoTIFF or a directory of tiles

`npm run map:download` downloads the supported City of Melbourne GeoJSON exports for buildings, trees, canopy, street furniture, public art, and parking. Add `--refresh-open-data` to replace those cached exports. The 12 GB DSM and statewide Vicmap products are intentionally never downloaded automatically.

`npm run map:build` consumes cached inputs, writes the base grid, SRTM corner-height grid, binary layers, sparse object index, address street index, ABS/locality area index, source report, attribution metadata, and preview under `public/maps`, then compiles every Melbourne chunk. Missing or invalid sources are recorded in `melbourne.sources.json` and deterministic compiler recipes fill unfinished coverage. Building import bakes a distinct authoritative-source bit into `melbourne.coverage.bin`; it covers footprint chunks, a one-chunk seam buffer, and enclosed empty areas such as parks. Synthetic buildings are generated only outside that mask. Buildings sample their base from the completed elevation lattice and never reshape it. Bridge and tunnel records embedded in the footprint source are instead emitted as dedicated `transport-structure` objects, including every component sharing their stable structure ID; their real outlines and AHD component elevations drive low-poly infrastructure geometry. Natural terrain and elevated bridge surfaces remain separate: bridge-tagged roads and bridge furniture use shallow, approach-matched deck profiles while the terrain heightfield and the clearance below them stay intact. Use `node scripts/build-map.mjs --heights-only` to rebake terrain without rebuilding the other map sources, or `npm run map:compile -- --scope=spawn` to rebuild only the committed pilot.

Street geometry follows explicit source measurements first, then OSM lane/sidewalk tags, and finally documented class defaults. Authoritative City of Melbourne footpath polygons suppress inferred sidewalk surfaces in covered chunks. Vehicle, pedestrian, and tram navigation paths are compiled from the same cross-sections as the render geometry; all runtime map data remains offline.

Before committing regenerated assets, run:

```sh
npm run test:map
npm run build
```
