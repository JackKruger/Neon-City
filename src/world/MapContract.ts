import data from '../../shared/map-contract.json';

export type Cell = '#' | 'C' | 'S' | 'P' | '.' | '~';

interface MapContractShape {
  mapId: 'melbourne';
  coordinateConvention: 'local-x-east-z-south';
  origin: 'map-center';
  center: { lat: number; lon: number };
  tileSize: number;
  mapSize: number;
  chunkTiles: number;
  chunkSize: number;
  validChunkBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  cellCodes: Record<Cell, number>;
  transportFlags: Record<'Road' | 'Bridge' | 'Tunnel' | 'Rail' | 'Tram' | 'Footpath' | 'Roundabout', number>;
  coverageFlags: Record<'Building' | 'Tree' | 'Parking' | 'Prop' | 'Address' | 'BuildingSource', number>;
  versions: Record<'authoredMap' | 'objectIndex' | 'roadIndex' | 'compiledManifest' | 'compiler' | 'runtime' | 'container' | 'provenance', number>;
  nbchSections: Record<'HGT1' | 'COL1' | 'NAV3' | 'GME1' | 'TRN1', number>;
}

export const MAP_CONTRACT = data as MapContractShape;
export const MAP_ID = MAP_CONTRACT.mapId;
export const TILE_SIZE = MAP_CONTRACT.tileSize;
export const MAP_SIZE = MAP_CONTRACT.mapSize;
export const CHUNK_TILES = MAP_CONTRACT.chunkTiles;
export const CHUNK_SIZE = MAP_CONTRACT.chunkSize;
export const VALID_CHUNK_BOUNDS = MAP_CONTRACT.validChunkBounds;
export const TransportFlag = MAP_CONTRACT.transportFlags;
export const CoverageFlag = MAP_CONTRACT.coverageFlags;
export const CODE_TO_CELL = Object.freeze(
  Object.entries(MAP_CONTRACT.cellCodes)
    .sort((left, right) => left[1] - right[1])
    .map(([cell]) => cell as Cell)
);

export function inMapWorld(x: number, z: number): boolean {
  const half = MAP_SIZE * TILE_SIZE / 2;
  return Number.isFinite(x) && Number.isFinite(z) && x >= -half && x < half && z >= -half && z < half;
}
