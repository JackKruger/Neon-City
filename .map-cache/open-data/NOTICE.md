# Committed open-data source export

This directory normally holds local-only source exports (see `.gitignore`). One
file is committed so the building importer's building-type handling is
reproducible without re-downloading:

## `building-footprints.geojson`

- **Dataset:** City of Melbourne 2023 Building Footprints (`2023-building-footprints`)
- **Source:** https://data.melbourne.vic.gov.au/explore/dataset/2023-building-footprints
- **Licence:** CC BY 4.0 — © City of Melbourne
- **Retrieved:** 2026-07-19 via `npm run map:download`
- **Records:** 41,701 footprints

The importer (`scripts/map/open-data.mjs`) reads each footprint's
`footprint_type` to separate real buildings (`Structure`) from labelled
infrastructure (`Bridge`, `Tunnel`, `Jetty`, `Tram Stop`, `Train Platform`,
`Ramp`, `Toilet`), retagging the latter to the `structure` object kind so they
are no longer extruded as generic buildings.

To refresh: `npm run map:download -- --refresh-open-data`.
