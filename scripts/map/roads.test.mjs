import assert from 'node:assert/strict';
import test from 'node:test';
import { roadInfoFromOverpass, roadSurfacesFromOverpass, roadWidth, sidewalkWidth } from './roads.mjs';

test('road widths prefer OSM dimensions and sensible class defaults', () => {
  assert.equal(roadWidth({ highway: 'residential' }), 8);
  assert.equal(roadWidth({ highway: 'primary', width: '11.5 m' }), 11.5);
  assert.equal(roadWidth({ highway: 'secondary', lanes: '4' }), 14);
  assert.equal(sidewalkWidth({ highway: 'residential' }), 1.8);
  assert.equal(sidewalkWidth({ highway: 'primary', 'sidewalk:left:width': '3.1 m' }, 'left'), 3.1);
});

test('road centerlines become bounded polygon strips', () => {
  const surfaces = roadSurfacesFromOverpass({
    elements: [{
      type: 'way',
      tags: { highway: 'residential' },
      geometry: [
        { lat: -37.835, lon: 144.9595 },
        { lat: -37.835, lon: 144.9605 },
      ],
    }],
  });
  assert.ok(surfaces.length >= 1);
  const rendered = surfaces.filter((item) => item.kind === 'road-surface');
  const navigation = surfaces.filter((item) => item.kind === 'nav-path');
  assert.ok(rendered.every((item) => item.outline.length >= 4));
  assert.ok(navigation.some((item) => item.mode === 'vehicle'));
  assert.ok(navigation.some((item) => item.mode === 'pedestrian'));
  const carriageway = rendered.find((item) => item.role === 'carriageway');
  const zValues = carriageway.outline.map((point) => point[1]);
  const width = Math.max(...zValues) - Math.min(...zValues);
  assert.equal(width, 8);
});

test('bridge and tunnel tags survive in road surfaces and navigation', () => {
  for (const [tag, structure] of [['bridge', 'bridge'], ['tunnel', 'tunnel']]) {
    const features = roadSurfacesFromOverpass({ elements: [{
      type: 'way', id: structure, tags: { highway: 'primary', [tag]: 'yes' }, geometry: [
        { lat: -37.835, lon: 144.9598 }, { lat: -37.835, lon: 144.9602 },
      ],
    }] });
    const carriageway = features.find((item) => item.kind === 'road-surface' && item.role === 'carriageway');
    const vehiclePaths = features.filter((item) => item.kind === 'nav-path' && item.mode === 'vehicle');
    assert.equal(carriageway?.structure, structure);
    assert.ok(vehiclePaths.length > 0);
    assert.ok(vehiclePaths.every((item) => item.structure === structure));
  }
});

test('non-junction bends are rounded and arterial edges receive markings', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'way', id: 7, nodes: [1, 2, 3],
    tags: { highway: 'primary', lanes: '2' },
    geometry: [
      { lat: -37.8350, lon: 144.9598 },
      { lat: -37.8350, lon: 144.9600 },
      { lat: -37.8348, lon: 144.9600 },
    ],
  }] });
  const vehicle = features.find((item) => item.kind === 'nav-path' && item.mode === 'vehicle');
  assert.ok(vehicle.points.length > 3, 'bend was not sampled into a smooth shared path');
  assert.equal(features.filter((item) => item.role?.startsWith('edge-line-')).length, 2);
});

test('bridge strips extend over a finite approach while navigation endpoints stay authored', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'way', id: 8, tags: { highway: 'primary', bridge: 'yes' },
    geometry: [
      { lat: -37.835, lon: 144.9598 },
      { lat: -37.835, lon: 144.9602 },
    ],
  }] });
  const road = features.find((item) => item.kind === 'road-surface' && item.role === 'carriageway');
  const nav = features.find((item) => item.kind === 'nav-path' && item.mode === 'vehicle');
  const roadExtent = Math.max(...road.outline.map(([x]) => x)) - Math.min(...road.outline.map(([x]) => x));
  const navExtent = Math.max(...nav.points.map(([x]) => x)) - Math.min(...nav.points.map(([x]) => x));
  assert.ok(roadExtent >= navExtent + 47, 'bridge surface does not cover both graded approaches');
});

test('tram centrelines generate standard-gauge rails and a tram graph', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'way', id: 9, tags: { railway: 'tram' }, geometry: [
      { lat: -37.835, lon: 144.9595 }, { lat: -37.835, lon: 144.9605 },
    ],
  }] });
  assert.equal(features.filter((item) => item.role?.startsWith('tram-rail')).length, 2);
  assert.ok(features.some((item) => item.kind === 'nav-path' && item.mode === 'tram'));
  const bed = features.find((item) => item.role === 'tram-bed');
  const rails = features.filter((item) => item.role?.startsWith('tram-rail'));
  assert.ok(bed.elevation >= 0.09);
  assert.ok(rails.every((item) => item.elevation >= bed.elevation + 0.03));
});

test('rail centrelines generate standard-gauge train tracks in both directions', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'way', id: 11, tags: { railway: 'rail', maxspeed: '80' }, geometry: [
      { lat: -37.835, lon: 144.9595 }, { lat: -37.835, lon: 144.9605 },
    ],
  }] });
  assert.equal(features.filter((item) => item.role?.startsWith('train-rail')).length, 2);
  const paths = features.filter((item) => item.kind === 'nav-path' && item.mode === 'train');
  assert.equal(paths.length, 2);
  assert.ok(paths.every((item) => item.speed === 80));
  assert.deepEqual(paths[0].points, [...paths[1].points].reverse());
});

test('transit stop nodes become named mode-specific records', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'node', id: 12, lat: -37.835, lon: 144.96,
    tags: { railway: 'tram_stop', name: 'Flinders Street' },
  }] });
  assert.deepEqual(features.map(({ kind, mode, name }) => ({ kind, mode, name })), [
    { kind: 'transit-stop', mode: 'tram', name: 'Flinders Street' },
  ]);
});

test('road information preserves names and speed limits in spatial chunks', () => {
  const info = roadInfoFromOverpass({ elements: [{
    type: 'way', id: 10, tags: { highway: 'primary', name: 'Flinders Street', maxspeed: '40' }, geometry: [
      { lat: -37.835, lon: 144.9595 }, { lat: -37.835, lon: 144.9605 },
    ],
  }] });
  assert.deepEqual(info.names, ['Flinders Street']);
  const segments = Object.values(info.chunks).flat();
  assert.ok(segments.length >= 2);
  assert.ok(segments.every(([name, speed]) => name === 0 && speed === 40));
});
