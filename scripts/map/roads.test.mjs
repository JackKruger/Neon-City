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

test('tram centrelines generate standard-gauge rails and a tram graph', () => {
  const features = roadSurfacesFromOverpass({ elements: [{
    type: 'way', id: 9, tags: { railway: 'tram' }, geometry: [
      { lat: -37.835, lon: 144.9595 }, { lat: -37.835, lon: 144.9605 },
    ],
  }] });
  assert.equal(features.filter((item) => item.role?.startsWith('tram-rail')).length, 2);
  assert.ok(features.some((item) => item.kind === 'nav-path' && item.mode === 'tram'));
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
