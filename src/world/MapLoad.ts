import { AuthoredMap, setAuthoredMap } from './CityMap';

/**
 * Fetch an authored map (produced by scripts/build-map.mjs) from /public/maps
 * and install it as the world's map source. Call before building any chunks.
 */
export async function loadAuthoredMap(name: string): Promise<AuthoredMap> {
  const [metaRes, binRes, suburbRes] = await Promise.all([
    fetch(`/maps/${name}.json`),
    fetch(`/maps/${name}.bin`),
    fetch(`/maps/${name}.suburbs.bin`).catch(() => null),
  ]);
  if (!metaRes.ok || !binRes.ok) {
    throw new Error(`failed to load map "${name}": ${metaRes.status}/${binRes.status}`);
  }
  const meta = await metaRes.json();
  const grid = new Uint8Array(await binRes.arrayBuffer());
  if (grid.length !== meta.width * meta.height) {
    throw new Error(`map "${name}" grid size mismatch`);
  }
  const map: AuthoredMap = {
    name: meta.name,
    width: meta.width,
    height: meta.height,
    grid,
    spawn: meta.spawn,
    attribution: meta.attribution ?? '',
  };
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
  setAuthoredMap(map);
  if (map.attribution) console.info(`[map] ${map.name}: ${map.attribution}`);
  return map;
}
