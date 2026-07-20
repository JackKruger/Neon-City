import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Drivable } from '../../src/entities/Drivable';
import { Helicopter } from '../../src/entities/Helicopter';
import { Player } from '../../src/entities/Player';

describe('airborne helicopter exit', () => {
  it('releases the pilot immediately with the helicopter momentum and a side jump', () => {
    const launch = vi.fn();
    const knockDown = vi.fn();
    const character = {
      setEnabled: vi.fn(),
      setFacing: vi.fn(),
      launch,
    };
    const helicopter = {
      kind: 'helicopter',
      command: { steer: 1, throttle: 1, brake: 0, handbrake: true },
      driver: null,
      canExit: vi.fn(() => false),
      doorPosition: vi.fn(() => new THREE.Vector3(12, 30, -5)),
      quaternion: vi.fn(() => new THREE.Quaternion()),
      getHeading: vi.fn(() => 0.4),
      setDoorOpen: vi.fn(),
      body: { linvel: vi.fn(() => ({ x: 8, y: -2, z: 4 })) },
    } as unknown as Drivable;
    const player = Object.create(Player.prototype) as Player;
    Object.assign(player, {
      vehicle: helicopter,
      vehicleTransition: null,
      vehicleDoorSide: 1,
      vehicleHitCooldown: 0,
      pendingMelee: null,
      character,
      knockDown,
    });
    helicopter.driver = player;

    player.exitVehicle();

    expect(player.vehicle).toBeNull();
    expect(helicopter.driver).toBeNull();
    expect(helicopter.command).toEqual({
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: false,
      descend: false,
    });
    expect(character.setEnabled).toHaveBeenCalledWith(true);
    expect(character.setFacing).toHaveBeenCalledWith(0.4);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0]).toEqual(new THREE.Vector3(12, 30, -5));
    expect(launch.mock.calls[0][1]).toEqual(new THREE.Vector3(10.5, -0.5, 4));
    expect(knockDown).toHaveBeenCalledWith(new THREE.Vector3(10.5, -0.5, 4), true);
  });

  it('ragdolls hard landings and kills the player at extreme impact speed', () => {
    const player = Object.create(Player.prototype) as Player;
    const knockDown = vi.fn();
    const die = vi.fn();
    const thwack = vi.fn();
    Object.assign(player, {
      vehicle: null,
      invincible: false,
      dead: false,
      knockedDown: false,
      health: 100,
      game: { audio: { thwack } },
      knockDown,
      die,
    });
    const handleLanding = (speed: number) => (
      player as unknown as { handleLandingImpact(speed: number): void }
    ).handleLandingImpact(speed);

    handleLanding(18);
    expect(player.health).toBe(60);
    expect(knockDown).toHaveBeenCalledOnce();
    expect(die).not.toHaveBeenCalled();

    handleLanding(25);
    expect(die).toHaveBeenCalledOnce();
    expect(thwack).toHaveBeenCalledTimes(2);
  });

  it('lets an abandoned airborne helicopter fall instead of freezing in place', () => {
    const setGravityScale = vi.fn();
    const helicopter = Object.create(Helicopter.prototype) as Helicopter;
    Object.assign(helicopter, {
      driver: null,
      flying: true,
      parkedAnchor: { x: 1, y: 20, z: 2, rotation: new THREE.Quaternion() },
      rotorSpeed: 12,
      mainRotor: new THREE.Group(),
      tailRotor: new THREE.Group(),
      model: new THREE.Group(),
      body: { setGravityScale },
      canExit: vi.fn(() => false),
    });

    helicopter.update(1 / 60);

    expect(setGravityScale).toHaveBeenCalledWith(1, true);
    expect((helicopter as unknown as { parkedAnchor: object | null }).parkedAnchor).toBeNull();
  });

  it('keeps the ragdoll airborne until it reaches a surface, then scores the fall', () => {
    let velocityY = -20;
    let position = new THREE.Vector3(0, 30, 0);
    const handleLandingImpact = vi.fn();
    const player = Object.create(Player.prototype) as Player;
    Object.assign(player, {
      ragdoll: {
        verticalSpeed: () => velocityY,
        position: () => position,
      },
      airborneRagdoll: true,
      airborneFallSpeed: 0,
      game: { surfaceHeightBelow: vi.fn(() => 0) },
      handleLandingImpact,
    });
    const updateAirborneRagdoll = () => (
      player as unknown as { updateAirborneRagdoll(): void }
    ).updateAirborneRagdoll();

    updateAirborneRagdoll();
    expect(handleLandingImpact).not.toHaveBeenCalled();

    velocityY = 0;
    position = new THREE.Vector3(0, 0.8, 0);
    updateAirborneRagdoll();
    expect(handleLandingImpact).toHaveBeenCalledWith(20, true);
    expect((player as unknown as { airborneRagdoll: boolean }).airborneRagdoll).toBe(false);
  });
});
