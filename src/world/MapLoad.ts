import { AuthoredMap, MapLayerName, RoadInfoIndex, setAuthoredMap } from './CityMap';

/**
 * Fetch an authored map (produced by scripts/build-map.mjs) from /public/maps
 * and install it as the world's map source. Call before building any chunks.
 */
export async function loadAuthoredMap(
  name: string,
  options: { loadObjects?: boolean } = {}
): Promise<AuthoredMap> {
  const [metaRes, binRes, suburbRes] = await Promise.all([
    fetch(`/maps/${name}.json`),
    fetch(`/maps/${name}.bin`),
    fetch(`/maps/${name}.suburbs.bin`).catch(() => null),
  ]);
  if (!metaRes.ok || !binRes.ok) {
    throw new Error(`failed to load map "${name}": ${metaRes.status}/${binRes.status}`);
  }
  const meta = await metaRes.json();
  if (meta.formatVersion !== undefined && meta.formatVersion !== 4) {
    throw new Error(`map "${name}" uses unsupported format version ${meta.formatVersion}`);
  }
  const grid = new Uint8Array(await binRes.arrayBuffer());
  if (grid.length !== meta.width * meta.height) {
    throw new Error(`map "${name}" grid size mismatch`);
  }
  const map: AuthoredMap = {
    name: meta.name,
    width: meta.width,
    height: meta.height,
    grid,
    heights: null,
    heightScale: 0.1,
    spawn: meta.spawn,
    attribution: meta.attribution ?? '',
  };
  if (meta.heightGrid && typeof meta.heightGrid.file === 'string') {
    try {
      const response = await fetch(`/maps/${meta.heightGrid.file}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const buffer = await response.arrayBuffer();
      const expected = (meta.width + 1) * (meta.height + 1);
      if (buffer.byteLength !== expected * Int16Array.BYTES_PER_ELEMENT) {
        throw new Error(`size mismatch: expected ${expected * 2} bytes, got ${buffer.byteLength}`);
      }
      const view = new DataView(buffer);
      const heights = new Int16Array(expected);
      for (let i = 0; i < expected; i++) heights[i] = view.getInt16(i * 2, true);
      map.heights = heights;
      map.heightScale = Number(meta.heightGrid.scale) || 0.1;
    } catch (error) {
      console.warn(`[map] ${name}: terrain heights unavailable (${error}); using flat ground`);
    }
  }
  if (Array.isArray(meta.suburbs) && suburbRes?.ok) {
    const suburbGrid = new Uint8Array(await suburbRes.arrayBuffer());
    if (suburbGrid.length === meta.width * meta.height) {
      map.suburbs = meta.suburbs;
      map.suburbGrid = suburbGrid;
    } else {
      console.warn(`[map] ${name}: suburb grid size mismatch; locality labels disabled`);
    }
  } else {
    console.warn(`[map] ${name}: suburb data unavailable; locality labels disabled`);
  }
  const layerNames = Array.isArray(meta.layers) ? meta.layers as MapLayerName[] : [];
  if (layerNames.length > 0) {
    const loaded = await Promise.all(layerNames.map(async (layerName) => {
      try {
        const response = await fetch(`/maps/${name}.${layerName}.bin`);
        if (!response.ok) throw new Error(`${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== meta.width * meta.height) throw new Error('size mismatch');
        return [layerName, bytes] as const;
      } catch (error) {
        console.warn(`[map] ${name}: ${layerName} layer unavailable (${error})`);
        return null;
      }
    }));
    map.layers = {};
    for (const entry of loaded) {
      if (entry) map.layers[entry[0]] = entry[1];
    }
  }
  {
    try {
      const response = await fetch(`/maps/${name}.roads.json`);
      if (!response.ok) throw new Error(`${response.status}`);
      const roadInfo = await response.json() as RoadInfoIndex;
      if (roadInfo.version !== 1 || roadInfo.chunkTiles !== 10 || roadInfo.tileSize !== 12 ||
          !Array.isArray(roadInfo.names) || typeof roadInfo.chunks !== 'object') {
        throw new Error('incompatible road information index');
      }
      map.roadInfo = roadInfo;
    } catch (error) {
      console.warn(`[map] ${name}: road names unavailable (${error})`);
    }
  }
  if (options.loadObjects !== false && typeof meta.objects === 'string') {
    try {
      const response = await fetch(`/maps/${meta.objects}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const objects = await response.json();
      if (!objects || ![1, 2].includes(objects.version) || typeof objects.chunks !== 'object') throw new Error('invalid object index');
      if (objects.version === 2 &&
          (objects.chunkTiles !== 10 || objects.ownership !== 'clipped-polygons')) {
        throw new Error('incompatible object index');
      }
      map.objectChunks = objects.chunks;
      map.roadSurfaces = objects.roadSurfaces === true;
    } catch (error) {
      console.warn(`[map] ${name}: authored objects unavailable (${error})`);
    }
  }
  setAuthoredMap(map);
  if (map.attribution) console.info(`[map] ${map.name}: ${map.attribution}`);
  return map;
}
