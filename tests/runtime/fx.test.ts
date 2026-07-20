import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { Fx } from '../../src/render/Fx';

describe('persistent blood stains', () => {
  it('projects onto the rendered surface instead of the lower terrain fallback', () => {
    const scene = new THREE.Scene();
    const surfaceRoot = new THREE.Group();
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshBasicMaterial()
    );
    surface.position.y = 2;
    surface.rotation.x = -Math.PI / 2;
    surfaceRoot.add(surface);
    scene.add(surfaceRoot);
    scene.updateMatrixWorld(true);
    const fallback = vi.fn(() => -5);
    const fx = new Fx(scene, fallback);
    fx.registerSurfaceRoot(surfaceRoot);

    fx.blood(new THREE.Vector3(0, 3, 0), undefined, 0.1);

    const stains = scene.children.filter((child): child is THREE.Mesh =>
      child instanceof THREE.Mesh && Math.abs(child.position.y - 2.012) < 0.001
    );
    expect(stains).toHaveLength(3);
    expect(fallback).not.toHaveBeenCalled();
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(stains[0].quaternion);
    expect(normal.y).toBeGreaterThan(0.99);
  });
});
