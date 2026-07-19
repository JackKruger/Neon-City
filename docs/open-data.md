# Melbourne open-data map build

The normal game uses committed map assets and does not call government services at runtime. The importer enriches the OSM grid when source exports are present in `.map-cache/open-data`. GeoJSON is preferred; a source may instead use the same basename with `.shp` plus its `.prj`, `.csv`, or pipe-delimited `.psv`.

Run `node scripts/build-map.mjs --list-open-data` for the complete filename list. The main local inputs are:

- `vicmap-transport.geojson`, `speed-zones.geojson`, and `vicmap-planning.geojson`
- `vicmap-address.geojson` or the fallback `gnaf-address.geojson`
- `geoscape-localities.geojson` or the fallback `abs-localities.geojson`
- `clue-floor-space.geojson` containing block or small-area geometry
- `melbourne-dsm.tif`, or set `MELBOURNE_DSM_PATH` to one GeoTIFF or a directory of tiles

`npm run map:download` downloads the supported City of Melbourne GeoJSON exports for buildings, trees, canopy, street furniture, public art, and parking. Add `--refresh-open-data` to replace those cached exports. The 12 GB DSM and statewide Vicmap products are intentionally never downloaded automatically.

`npm run map:build` consumes cached inputs, writes the base grid, SRTM corner-height grid, binary layers, sparse object index, address street index, ABS/locality area index, source report, attribution metadata, and preview under `public/maps`, then compiles every Melbourne chunk. Missing or invalid sources are recorded in `melbourne.sources.json` and deterministic compiler recipes fill unfinished coverage. Building import bakes a distinct authoritative-source bit into `melbourne.coverage.bin`; it covers footprint chunks, a one-chunk seam buffer, and enclosed empty areas such as parks. Synthetic buildings are generated only outside that mask. Use `node scripts/build-map.mjs --heights-only` to rebake terrain without rebuilding the other map sources, or `npm run map:compile -- --scope=spawn` to rebuild only the committed pilot.

Before committing regenerated assets, run:

```sh
npm run test:map
npm run build
```
