import { readFileSync } from 'node:fs';

export const MAP_CONTRACT_PATH = new URL('../../shared/map-contract.json', import.meta.url);
export const MAP_CONTRACT = Object.freeze(JSON.parse(readFileSync(MAP_CONTRACT_PATH, 'utf8')));
export const MAP_ID = MAP_CONTRACT.mapId;
export const TILE = MAP_CONTRACT.tileSize;
export const MAP_SIZE = MAP_CONTRACT.mapSize;
export const MAP_CENTER = Object.freeze(MAP_CONTRACT.center);
export const CHUNK_TILES = MAP_CONTRACT.chunkTiles;
export const CHUNK_SIZE = MAP_CONTRACT.chunkSize;
export const MIN_CHUNK = MAP_CONTRACT.validChunkBounds.minX;
export const MAX_CHUNK = MAP_CONTRACT.validChunkBounds.maxX;
export const CELL_CODES = Object.freeze(MAP_CONTRACT.cellCodes);
export const TRANSPORT_FLAGS = Object.freeze(MAP_CONTRACT.transportFlags);
export const COVERAGE_FLAGS = Object.freeze(MAP_CONTRACT.coverageFlags);
export const VERSIONS = Object.freeze(MAP_CONTRACT.versions);
export const NBCH_SECTIONS = Object.freeze(MAP_CONTRACT.nbchSections);
export const SECTION_TYPES = Object.freeze(Object.keys(NBCH_SECTIONS));
