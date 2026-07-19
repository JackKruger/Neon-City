import assert from 'node:assert/strict';
import test from 'node:test';
import { roadSurfacesFromOverpass, roadWidth } from './roads.mjs';

test('road widths prefer OSM dimensions and sensible class defaults', () => {
  assert.equal(roadWidth({ highway: 'residential' }), 8);
  assert.equal(roadWidth({ highway: 'primary', width: '11.5 m' }), 11.5);
  assert.equal(roadWidth({ highway: 'secondary', lanes: '4' }), 14);
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
  assert.ok(surfaces.every((item) => item.kind === 'road-surface' && item.outline.length >= 4));
  const zValues = surfaces[0].outline.map((point) => point[1]);
  const width = Math.max(...zValues) - Math.min(...zValues);
  assert.equal(width, 8);
});
