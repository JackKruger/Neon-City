import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CopPed } from '../../src/entities/CopPed';
import { Pedestrian } from '../../src/entities/Pedestrian';
import { Player } from '../../src/entities/Player';
import { Ragdoll } from '../../src/entities/Ragdoll';
import { Wanted } from '../../src/gameplay/Wanted';

describe('ragdoll recovery and on-foot arrest transitions', () => {
  it('derives a stable face-up recovery direction from the settled pelvis', () => {
    const yaw = 0.72;
    const rotation = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
    const ragdoll = Object.create(Ragdoll.prototype) as Ragdoll;
    Object.assign(ragdoll, {
      pieces: [{
        body: {
          translation: () => ({ x: 4, y: 1.1, z: -3 }),
          rotation: () => rotation,
        },
      }],
    });

    const recovery = ragdoll.recoveryPose(0);

    expect(recovery.position).toEqual(new THREE.Vector3(4, 1.1, -3));
    expect(recovery.faceUp).toBe(true);
    expect(recovery.yaw).toBeCloseTo(yaw);
  });

  it('keeps the player down until the get-up pose reaches its standing frame', () => {
    const setGetUpPose = vi.fn();
    const finishScriptedPose = vi.fn();
    const nextCharacter = {
      beginScriptedPose: vi.fn(),
      setGetUpPose,
      finishScriptedPose,
    };
    const rebuildCharacter = vi.fn(function (this: Player) {
      Object.assign(this, { ragdoll: null, character: nextCharacter });
    });
    const recoveryPose = vi.fn(() => ({
      position: new THREE.Vector3(8, 1, 5),
      yaw: 1.2,
      faceUp: false,
    }));
    const player = Object.create(Player.prototype) as Player;
    Object.assign(player, {
      character: { getFacing: () => 0.4 },
      ragdoll: { recoveryPose },
      knockedDown: true,
      airborneRagdoll: false,
      airborneFallSpeed: 0,
      vehicleHitCooldown: 0,
      game: { surfaceHeightBelow: vi.fn(() => 2.5) },
      rebuildCharacter,
      getUpTransition: null,
    });
    const beginStandUp = () => (
      player as unknown as { beginStandUp(): void }
    ).beginStandUp();
    const updateGetUp = (dt: number) => (
      player as unknown as { updateGetUpTransition(dt: number): void }
    ).updateGetUpTransition(dt);

    beginStandUp();
    expect(recoveryPose).toHaveBeenCalledWith(0.4);
    expect(rebuildCharacter).toHaveBeenCalledWith(8, 5, 2.5, 1.2);
    expect(nextCharacter.beginScriptedPose).toHaveBeenCalledOnce();
    expect(setGetUpPose).toHaveBeenLastCalledWith(
      new THREE.Vector3(8, 2.5, 5),
      1.2,
      0,
      false
    );
    expect(player.knockedDown).toBe(true);

    updateGetUp(1.25);
    expect(finishScriptedPose).toHaveBeenCalledWith(new THREE.Vector3(8, 2.5, 5), 1.2);
    expect(player.knockedDown).toBe(false);
    expect((player as unknown as { getUpTransition: object | null }).getUpTransition).toBeNull();
  });

  it('keeps a recovering pedestrian non-interactive until its get-up finishes', () => {
    const feet = new THREE.Vector3(3, 0.5, -2);
    const character = {
      setGetUpPose: vi.fn(),
      finishScriptedPose: vi.fn(),
    };
    const pedestrian = Object.create(Pedestrian.prototype) as Pedestrian;
    Object.assign(pedestrian, {
      character,
      knockedDown: true,
      impactCooldown: 3,
      getUpTransition: { elapsed: 0, feet, yaw: -0.7, faceUp: true },
    });
    const updateGetUp = (dt: number) => (
      pedestrian as unknown as { updateGetUpTransition(dt: number): void }
    ).updateGetUpTransition(dt);

    updateGetUp(0.5);
    expect(character.setGetUpPose).toHaveBeenLastCalledWith(feet, -0.7, 0.4, true);
    expect((pedestrian as unknown as { knockedDown: boolean }).knockedDown).toBe(true);

    updateGetUp(0.75);
    expect(character.finishScriptedPose).toHaveBeenCalledWith(feet, -0.7);
    expect((pedestrian as unknown as { knockedDown: boolean }).knockedDown).toBe(false);
    expect((pedestrian as unknown as { impactCooldown: number }).impactCooldown).toBe(0.8);
  });

  it('starts a paired tackle before resolving an on-foot bust', () => {
    const character = {
      collider: {},
      rig: {},
      position: () => new THREE.Vector3(10, 0, 0),
      getFacing: () => 0,
      setFacing: vi.fn(),
      beginScriptedPose: vi.fn(),
      setTacklePose: vi.fn(),
      setEnabled: vi.fn(),
    };
    const tackler = {
      position: () => new THREE.Vector3(8, 0, 0),
      beginTackle: vi.fn(),
    };
    const audio = { thwack: vi.fn(), busted: vi.fn() };
    const player = Object.create(Player.prototype) as Player;
    Object.assign(player, {
      dead: false,
      knockedDown: false,
      vehicle: null,
      vehicleTransition: null,
      pendingMelee: null,
      ragdoll: null,
      getUpTransition: null,
      bustTransition: null,
      character,
      wanted: { clear: vi.fn() },
      game: {
        surfaceHeightBelow: vi.fn(() => 0),
        combat: { unregister: vi.fn() },
        audio,
      },
    });

    player.bust(200, tackler as unknown as CopPed);

    expect(character.beginScriptedPose).toHaveBeenCalledOnce();
    expect(character.setTacklePose).toHaveBeenCalledWith(new THREE.Vector3(10, 0, 0), Math.PI / 2, 0, 'victim');
    expect(tackler.beginTackle).toHaveBeenCalledWith(new THREE.Vector3(10, 0, 0), 1.05);
    expect(player.dead).toBe(false);
    expect(player.alive()).toBe(false);
    expect(player.canSave).toBe(false);

    const transition = (player as unknown as { bustTransition: { impacted: boolean } }).bustTransition;
    transition.impacted = true;
    Object.assign(player, { ragdoll: { update: vi.fn() } });
    (
      player as unknown as { updateBustTransition(dt: number): void }
    ).updateBustTransition(1.05);
    expect(player.dead).toBe(true);
    expect(player.hudMessage).toBe('BUSTED');
    expect(audio.busted).toHaveBeenCalledOnce();
  });

  it('moves the officer through a tackle lunge and safely restores collision', () => {
    const character = {
      rig: { setHeldItem: vi.fn() },
      position: () => new THREE.Vector3(0, 0, 0),
      setFacing: vi.fn(),
      beginScriptedPose: vi.fn(),
      setTacklePose: vi.fn(),
      finishScriptedPose: vi.fn(),
    };
    const cop = Object.create(CopPed.prototype) as CopPed;
    Object.assign(cop, {
      dead: false,
      pendingPunch: true,
      tackle: null,
      character,
    });

    cop.beginTackle(new THREE.Vector3(2, 0, 0), 1);
    expect(character.rig.setHeldItem).toHaveBeenCalledWith(null);
    expect(character.beginScriptedPose).toHaveBeenCalledOnce();
    expect(character.setTacklePose).toHaveBeenCalledWith(new THREE.Vector3(0, 0, 0), Math.PI / 2, 0, 'attacker');

    (
      cop as unknown as { updateTackle(dt: number): void }
    ).updateTackle(1);
    expect(character.finishScriptedPose).toHaveBeenCalledWith(new THREE.Vector3(1.38, 0, 0), Math.PI / 2);
    expect((cop as unknown as { tackle: object | null }).tackle).toBeNull();
  });

  it('selects the closest on-foot cop as the arrest tackler', () => {
    const bust = vi.fn();
    const player = {
      driving: false,
      dead: false,
      position: () => new THREE.Vector3(),
      bust,
    };
    const wanted = new Wanted({} as never, player as never);
    wanted.setLockedLevel(2);
    const nearCop = {
      dead: false,
      leaving: false,
      position: () => new THREE.Vector3(1, 0, 0),
    };
    const farCop = {
      dead: false,
      leaving: false,
      position: () => new THREE.Vector3(2, 0, 0),
    };
    wanted.copPeds.push(nearCop as never, farCop as never);

    wanted.update(1.36);

    expect(bust).toHaveBeenCalledWith(200, nearCop);
  });
});
