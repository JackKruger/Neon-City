import * as THREE from 'three';

/** Colors for one person's skin, hair and clothing. */
export interface Outfit {
  skin: number;
  hair: number;
  shirt: number;
  pants: number;
  shoes: number;
}

/** Collider/joint description of one rigid part, for building a ragdoll. */
export interface RagdollPartSpec {
  name: string;
  /** Joint pivot node; the part's body frame shares its orientation. */
  pivot: THREE.Object3D;
  /** Index of the parent part in the parts array (-1 for the pelvis root). */
  parent: number;
  /** Collider center in pivot-local (unscaled) coordinates. */
  center: THREE.Vector3;
  shape:
    | { kind: 'capsule'; halfHeight: number; radius: number }
    | { kind: 'box'; hx: number; hy: number; hz: number };
  /** Joint connecting this part to its parent, anchored at the pivot origin. */
  joint:
    | { kind: 'spherical' }
    | { kind: 'hinge'; axis: THREE.Vector3; min: number; max: number }
    | null;
  /** Visual nodes attached to the pivot (excludes child part pivots). */
  meshes: THREE.Object3D[];
}

// --- Proportions (meters, for a 1.8 m person; ~7.5 head-heights) ---------
const PELVIS_Y = 1.0; // pelvis pivot height
const HIP_X = 0.09; // hip pivot lateral offset
const HIP_DROP = 0.04; // hip pivot below pelvis pivot
const THIGH_LEN = 0.45; // hip -> knee
const SHIN_LEN = 0.42; // knee -> ankle
const FOOT_H = 0.09; // ankle height above sole
const FOOT_LEN = 0.25;
const WAIST_UP = 0.08; // pelvis pivot -> waist joint
const CHEST_LEN = 0.38; // waist -> shoulder line
const SHOULDER_X = 0.19;
const SHOULDER_DROP = 0.02; // shoulders slightly below chest top
const UPPER_ARM_LEN = 0.31; // shoulder -> elbow
const FOREARM_LEN = 0.26; // elbow -> wrist
const HAND_LEN = 0.16;
const NECK_LEN = 0.06;
const HEAD_R = 0.105;

const THIGH_R = 0.07;
const SHIN_R = 0.054;
const UPPER_ARM_R = 0.047;
const FOREARM_R = 0.04;

// Shared geometry cache — every rig with the same dimensions reuses buffers.
const GEO = new Map<string, THREE.BufferGeometry>();
function capsule(radius: number, length: number): THREE.BufferGeometry {
  const key = `c${radius}:${length}`;
  let g = GEO.get(key);
  if (!g) {
    g = new THREE.CapsuleGeometry(radius, Math.max(0.01, length - radius * 2), 4, 10);
    GEO.set(key, g);
  }
  return g;
}
function box(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `b${w}:${h}:${d}`;
  let g = GEO.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    GEO.set(key, g);
  }
  return g;
}
function sphere(radius: number): THREE.BufferGeometry {
  const key = `s${radius}`;
  let g = GEO.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(radius, 12, 10);
    GEO.set(key, g);
  }
  return g;
}

// Shared materials keyed by color — outfits draw from small palettes.
const MATS = new Map<number, THREE.MeshStandardMaterial>();
function material(color: number): THREE.MeshStandardMaterial {
  let m = MATS.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02 });
    MATS.set(color, m);
  }
  return m;
}

interface Leg {
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
}
interface Arm {
  shoulder: THREE.Group;
  elbow: THREE.Group;
}

/**
 * Procedural articulated human. The hierarchy pivots at real joints
 * (neck, shoulders, elbows, hips, knees, ankles) so the same skeleton
 * drives both the walk animation and the physics ragdoll.
 *
 * Root sits at ground level between the feet; the body faces +Z.
 */
export class HumanRig {
  readonly root = new THREE.Group();
  /** Uniform body scale (height variation between people). */
  readonly scale: number;

  private pelvis = new THREE.Group();
  private spine = new THREE.Group();
  private neck = new THREE.Group();
  private legL!: Leg;
  private legR!: Leg;
  private armL!: Arm;
  private armR!: Arm;
  private specs: RagdollPartSpec[] = [];
  /** Right-hand attach point for held weapons (+Z out of the grip). */
  private handSocketR = new THREE.Group();
  private heldItem: THREE.Object3D | null = null;

  constructor(outfit: Outfit, scale = 1) {
    this.scale = scale;
    this.root.scale.setScalar(scale);

    // Pelvis (root part).
    this.pelvis.position.y = PELVIS_Y;
    this.root.add(this.pelvis);
    const pelvisMesh = new THREE.Mesh(capsule(0.13, 0.32), material(outfit.pants));
    pelvisMesh.scale.set(1.15, 0.62, 0.82);
    pelvisMesh.position.y = -0.02;
    this.pelvis.add(pelvisMesh);
    this.addSpec({
      name: 'pelvis',
      pivot: this.pelvis,
      parent: -1,
      center: new THREE.Vector3(0, -0.02, 0),
      shape: { kind: 'capsule', halfHeight: 0.03, radius: 0.115 },
      joint: null,
      meshes: [pelvisMesh],
    });

    // Chest / spine.
    this.spine.position.y = WAIST_UP;
    this.pelvis.add(this.spine);
    const chestMesh = new THREE.Mesh(capsule(0.135, CHEST_LEN + 0.16), material(outfit.shirt));
    chestMesh.scale.set(1.3, 1, 0.78);
    chestMesh.position.y = CHEST_LEN / 2;
    this.spine.add(chestMesh);
    const chestIdx = this.addSpec({
      name: 'chest',
      pivot: this.spine,
      parent: 0,
      center: new THREE.Vector3(0, CHEST_LEN / 2, 0),
      shape: { kind: 'capsule', halfHeight: CHEST_LEN / 2 - 0.05, radius: 0.13 },
      joint: { kind: 'spherical' },
      meshes: [chestMesh],
    });

    // Neck + head.
    this.neck.position.y = CHEST_LEN + 0.02;
    this.spine.add(this.neck);
    const neckMesh = new THREE.Mesh(capsule(0.045, 0.14), material(outfit.skin));
    neckMesh.position.y = NECK_LEN / 2;
    this.neck.add(neckMesh);
    const headY = NECK_LEN + HEAD_R + 0.02;
    const headMesh = new THREE.Mesh(sphere(HEAD_R), material(outfit.skin));
    headMesh.scale.set(0.92, 1.08, 0.98);
    headMesh.position.y = headY;
    this.neck.add(headMesh);
    const hairMesh = new THREE.Mesh(sphere(HEAD_R * 1.02), material(outfit.hair));
    hairMesh.scale.set(0.95, 0.95, 0.95);
    hairMesh.position.set(0, headY + 0.035, -0.022);
    this.neck.add(hairMesh);
    const noseMesh = new THREE.Mesh(sphere(0.018), material(outfit.skin));
    noseMesh.position.set(0, headY - 0.01, HEAD_R * 0.95);
    this.neck.add(noseMesh);
    this.addSpec({
      name: 'head',
      pivot: this.neck,
      parent: chestIdx,
      center: new THREE.Vector3(0, headY, 0),
      shape: { kind: 'capsule', halfHeight: 0.03, radius: HEAD_R },
      joint: { kind: 'spherical' },
      meshes: [neckMesh, headMesh, hairMesh, noseMesh],
    });

    this.armL = this.buildArm(outfit, chestIdx, 1);
    this.armR = this.buildArm(outfit, chestIdx, -1);
    this.legL = this.buildLeg(outfit, 1);
    this.legR = this.buildLeg(outfit, -1);
  }

  private addSpec(spec: RagdollPartSpec): number {
    this.specs.push(spec);
    return this.specs.length - 1;
  }

  private buildArm(outfit: Outfit, chestIdx: number, side: 1 | -1): Arm {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * SHOULDER_X, CHEST_LEN - SHOULDER_DROP, 0);
    this.spine.add(shoulder);
    // Short sleeve over the shoulder, skin below.
    const sleeve = new THREE.Mesh(capsule(UPPER_ARM_R + 0.012, 0.18), material(outfit.shirt));
    sleeve.position.y = -0.06;
    shoulder.add(sleeve);
    const upperMesh = new THREE.Mesh(capsule(UPPER_ARM_R, UPPER_ARM_LEN), material(outfit.skin));
    upperMesh.position.y = -UPPER_ARM_LEN / 2;
    shoulder.add(upperMesh);
    const upperIdx = this.addSpec({
      name: `upperArm${side > 0 ? 'L' : 'R'}`,
      pivot: shoulder,
      parent: chestIdx,
      center: new THREE.Vector3(0, -UPPER_ARM_LEN / 2, 0),
      shape: { kind: 'capsule', halfHeight: UPPER_ARM_LEN / 2 - UPPER_ARM_R, radius: UPPER_ARM_R },
      joint: { kind: 'spherical' },
      meshes: [sleeve, upperMesh],
    });

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM_LEN;
    shoulder.add(elbow);
    const foreMesh = new THREE.Mesh(capsule(FOREARM_R, FOREARM_LEN + 0.04), material(outfit.skin));
    foreMesh.position.y = -FOREARM_LEN / 2;
    elbow.add(foreMesh);
    const handMesh = new THREE.Mesh(capsule(0.038, HAND_LEN), material(outfit.skin));
    handMesh.scale.set(0.8, 1, 1.15);
    handMesh.position.y = -FOREARM_LEN - HAND_LEN / 2 + 0.05;
    elbow.add(handMesh);
    const reach = FOREARM_LEN + HAND_LEN - 0.05; // elbow to fingertip
    this.addSpec({
      name: `forearm${side > 0 ? 'L' : 'R'}`,
      pivot: elbow,
      parent: upperIdx,
      center: new THREE.Vector3(0, -reach / 2, 0),
      shape: { kind: 'capsule', halfHeight: reach / 2 - FOREARM_R, radius: FOREARM_R },
      // Elbows only fold forward (negative pitch), never hyperextend.
      joint: { kind: 'hinge', axis: new THREE.Vector3(1, 0, 0), min: -2.4, max: 0.02 },
      meshes: [foreMesh, handMesh],
    });
    if (side === -1) {
      // Weapon socket at the palm. Not part of any RagdollPartSpec, so the
      // ragdoll never steals a held item; it is dropped via setHeldItem(null).
      this.handSocketR.position.set(0, -FOREARM_LEN - HAND_LEN / 2 + 0.05, 0.02);
      this.handSocketR.rotation.x = Math.PI / 2; // grip +Z continues the forearm
      elbow.add(this.handSocketR);
    }
    return { shoulder, elbow };
  }

  /** Put a weapon model in the right hand (null to holster). */
  setHeldItem(mesh: THREE.Object3D | null): void {
    if (this.heldItem) this.heldItem.removeFromParent();
    this.heldItem = mesh;
    if (mesh) this.handSocketR.add(mesh);
  }

  private buildLeg(outfit: Outfit, side: 1 | -1): Leg {
    const hip = new THREE.Group();
    hip.position.set(side * HIP_X, -HIP_DROP, 0);
    this.pelvis.add(hip);
    const thighMesh = new THREE.Mesh(capsule(THIGH_R, THIGH_LEN + 0.1), material(outfit.pants));
    thighMesh.position.y = -THIGH_LEN / 2 + 0.02;
    hip.add(thighMesh);
    const thighIdx = this.addSpec({
      name: `thigh${side > 0 ? 'L' : 'R'}`,
      pivot: hip,
      parent: 0,
      center: new THREE.Vector3(0, -THIGH_LEN / 2, 0),
      shape: { kind: 'capsule', halfHeight: THIGH_LEN / 2 - THIGH_R, radius: THIGH_R },
      joint: { kind: 'spherical' },
      meshes: [thighMesh],
    });

    const knee = new THREE.Group();
    knee.position.y = -THIGH_LEN;
    hip.add(knee);
    const shinMesh = new THREE.Mesh(capsule(SHIN_R, SHIN_LEN + 0.08), material(outfit.pants));
    shinMesh.position.y = -SHIN_LEN / 2;
    knee.add(shinMesh);
    const shinIdx = this.addSpec({
      name: `shin${side > 0 ? 'L' : 'R'}`,
      pivot: knee,
      parent: thighIdx,
      center: new THREE.Vector3(0, -SHIN_LEN / 2, 0),
      shape: { kind: 'capsule', halfHeight: SHIN_LEN / 2 - SHIN_R, radius: SHIN_R },
      // Knees only fold backward (positive pitch here), never hyperextend.
      joint: { kind: 'hinge', axis: new THREE.Vector3(1, 0, 0), min: -0.02, max: 2.4 },
      meshes: [shinMesh],
    });

    const ankle = new THREE.Group();
    ankle.position.y = -SHIN_LEN;
    knee.add(ankle);
    const footMesh = new THREE.Mesh(box(0.095, FOOT_H - 0.02, FOOT_LEN), material(outfit.shoes));
    footMesh.position.set(0, -FOOT_H + (FOOT_H - 0.02) / 2, FOOT_LEN / 2 - 0.075);
    ankle.add(footMesh);
    this.addSpec({
      name: `foot${side > 0 ? 'L' : 'R'}`,
      pivot: ankle,
      parent: shinIdx,
      center: new THREE.Vector3(0, -FOOT_H / 2, FOOT_LEN / 2 - 0.075),
      shape: { kind: 'box', hx: 0.05, hy: FOOT_H / 2, hz: FOOT_LEN / 2 },
      joint: { kind: 'hinge', axis: new THREE.Vector3(1, 0, 0), min: -0.7, max: 0.7 },
      meshes: [footMesh],
    });
    return { hip, knee, ankle };
  }

  /** Ragdoll construction data. Parts are ordered parent-before-child. */
  parts(): RagdollPartSpec[] {
    return this.specs;
  }

  /**
   * Pose the skeleton for locomotion.
   * @param phase gait cycle in radians (one full cycle = two steps)
  * @param blend 0 = standing idle, 1 = full stride
  * @param run 0 = walk gait, 1 = run gait
  * @param time absolute seconds, for idle micro-motion
   * @param airborne 0 = grounded pose, 1 = full jump pose
   * @param verticalSpeed positive while rising, negative while falling
   */
  setLocomotion(
    phase: number,
    blend: number,
    run: number,
    time: number,
    airborne = 0,
    verticalSpeed = 0
  ): void {
    const hipAmp = 0.5 + 0.35 * run;
    const armAmp = 0.4 + 0.5 * run;

    this.poseLeg(this.legL, phase, blend, run, hipAmp);
    this.poseLeg(this.legR, phase + Math.PI, blend, run, hipAmp);
    // Contralateral arm swing: same-side arm moves opposite the leg.
    this.poseArm(this.armL, phase, blend, run, armAmp, 1);
    this.poseArm(this.armR, phase + Math.PI, blend, run, armAmp, -1);

    // Torso: slight forward lean that grows with speed, gentle counter-sway,
    // and a breathing idle so standing still doesn't look frozen.
    const breathe = Math.sin(time * 1.9) * 0.012;
    this.spine.rotation.x = 0.05 * blend + 0.22 * run * blend + breathe;
    this.spine.rotation.y = 0.1 * blend * Math.sin(phase);
    this.pelvis.rotation.y = -0.06 * blend * Math.sin(phase);
    this.pelvis.rotation.z = 0.045 * blend * Math.sin(phase);
    // Head stays level and looks where it's going.
    this.neck.rotation.x = -this.spine.rotation.x * 0.75;
    this.neck.rotation.y = -this.spine.rotation.y * 0.6;

    // Center-of-mass bob: two per cycle, deepest at double support.
    const bob = blend * (0.02 + 0.025 * run) * Math.abs(Math.cos(phase));
    this.pelvis.position.y = PELVIS_Y - blend * 0.03 * (1 + run) - bob;

    if (airborne > 0.001) this.blendJumpPose(airborne, verticalSpeed);
  }

  /** Tuck both legs in the air, then extend slightly while descending. */
  private blendJumpPose(blend: number, verticalSpeed: number): void {
    const falling = THREE.MathUtils.clamp(-verticalSpeed / 8, 0, 1);
    const tuck = 1 - falling * 0.22;
    const mix = (from: number, to: number) => THREE.MathUtils.lerp(from, to, blend);

    // Offset the legs a little so the silhouette feels natural instead of
    // snapping into a perfectly symmetrical seated pose.
    this.legL.hip.rotation.x = mix(this.legL.hip.rotation.x, -0.58 * tuck);
    this.legR.hip.rotation.x = mix(this.legR.hip.rotation.x, -0.42 * tuck);
    this.legL.knee.rotation.x = mix(this.legL.knee.rotation.x, 1.28 * tuck);
    this.legR.knee.rotation.x = mix(this.legR.knee.rotation.x, 1.08 * tuck);
    this.legL.ankle.rotation.x = mix(this.legL.ankle.rotation.x, -0.34);
    this.legR.ankle.rotation.x = mix(this.legR.ankle.rotation.x, -0.28);

    // Bring the arms forward to sell the lift and keep the torso compact.
    this.armL.shoulder.rotation.x = mix(this.armL.shoulder.rotation.x, -0.72);
    this.armR.shoulder.rotation.x = mix(this.armR.shoulder.rotation.x, -0.58);
    this.armL.elbow.rotation.x = mix(this.armL.elbow.rotation.x, -0.42);
    this.armR.elbow.rotation.x = mix(this.armR.elbow.rotation.x, -0.36);
    this.spine.rotation.x = mix(this.spine.rotation.x, -0.08);
    this.neck.rotation.x = mix(this.neck.rotation.x, 0.05);
    this.pelvis.rotation.y *= 1 - blend;
    this.pelvis.rotation.z *= 1 - blend;
    this.pelvis.position.y = THREE.MathUtils.lerp(
      this.pelvis.position.y,
      PELVIS_Y + 0.03,
      0.8 * blend
    );
  }

  /**
   * Overlay an attack swing on the locomotion pose (call after setLocomotion).
   * The right arm at side -1 sits at negative X; positive spine yaw brings it
   * forward. @param t swing progress 0..1; contact lands around t≈0.45.
   */
  poseAttack(kind: 'punch' | 'swing', t: number, twoHanded: boolean): void {
    const p = THREE.MathUtils.clamp(t, 0, 1);
    // Ramp the overlay in and out so it never pops against locomotion.
    const w = Math.min(1, p * 5, (1 - p) * 5);
    const arm = this.armR;
    const mix = THREE.MathUtils.lerp;
    if (kind === 'punch') {
      const extend = Math.sin(Math.PI * Math.pow(p, 0.85)); // peak near t≈0.45
      arm.shoulder.rotation.x = mix(arm.shoulder.rotation.x, -1.45 * extend, w);
      arm.shoulder.rotation.z = mix(arm.shoulder.rotation.z, -0.1, w);
      arm.elbow.rotation.x = mix(arm.elbow.rotation.x, -1.9 + 1.82 * extend, w);
      this.spine.rotation.y = mix(this.spine.rotation.y, 0.38 * extend, w);
    } else {
      // Wind up twisting away, sweep through, then recover.
      let yaw: number;
      if (p < 0.3) yaw = -0.6 * Math.sin((p / 0.3) * Math.PI * 0.5);
      else if (p < 0.65) yaw = mix(-0.6, 0.85, (p - 0.3) / 0.35);
      else yaw = 0.85 * (1 - (p - 0.65) / 0.35);
      this.spine.rotation.y = mix(this.spine.rotation.y, yaw, w);
      const raise = Math.sin(Math.PI * Math.min(1, p * 1.4));
      arm.shoulder.rotation.x = mix(arm.shoulder.rotation.x, -1.2 * raise, w);
      arm.shoulder.rotation.z = mix(arm.shoulder.rotation.z, p < 0.3 ? -0.55 : -0.15, w * raise);
      arm.elbow.rotation.x = mix(arm.elbow.rotation.x, p < 0.3 ? -0.7 : -0.12, w);
      if (twoHanded) {
        this.armL.shoulder.rotation.x = mix(this.armL.shoulder.rotation.x, -1.05 * raise, w);
        this.armL.shoulder.rotation.z = mix(this.armL.shoulder.rotation.z, -0.2, w * raise);
        this.armL.elbow.rotation.x = mix(this.armL.elbow.rotation.x, -0.6, w);
      }
      this.neck.rotation.y = mix(this.neck.rotation.y, -yaw * 0.7, w); // eyes on target
    }
  }

  /** Hold the equipped gun up toward the facing direction. */
  poseAim(long: boolean, w: number): void {
    const mix = THREE.MathUtils.lerp;
    const arm = this.armR;
    arm.shoulder.rotation.x = mix(arm.shoulder.rotation.x, -1.5, w);
    arm.shoulder.rotation.z = mix(arm.shoulder.rotation.z, -0.06, w);
    arm.elbow.rotation.x = mix(arm.elbow.rotation.x, -0.05, w);
    this.spine.rotation.y = mix(this.spine.rotation.y, 0.12, w);
    this.neck.rotation.y = mix(this.neck.rotation.y, -0.12, w);
    if (long) {
      // Support hand reaches across to the fore-end.
      this.armL.shoulder.rotation.x = mix(this.armL.shoulder.rotation.x, -1.3, w);
      this.armL.shoulder.rotation.z = mix(this.armL.shoulder.rotation.z, -0.28, w);
      this.armL.elbow.rotation.x = mix(this.armL.elbow.rotation.x, -0.55, w);
    }
  }

  /** Brief hit reaction: head and torso recoil backward. */
  poseFlinch(w: number): void {
    this.spine.rotation.x += -0.28 * w;
    this.neck.rotation.x += 0.2 * w;
    this.spine.rotation.y += 0.15 * w;
  }

  private poseLeg(leg: Leg, p: number, blend: number, run: number, hipAmp: number): void {
    const swing = Math.sin(p);
    // Negative pitch swings the leg forward (+Z).
    leg.hip.rotation.x = -hipAmp * blend * swing;
    // Knee folds during the swing-through (leg moving from back to front),
    // arrives straight for heel strike, plus a slight always-on bend.
    const fold = Math.max(0, Math.sin(p - 1.9));
    const stanceFlex = Math.max(0, Math.cos(p)) * 0.12; // shock absorb at stance
    leg.knee.rotation.x = blend * (0.08 + (0.85 + 1.0 * run) * fold + stanceFlex);
    // Keep the foot near-level: toe-off points, swing-through lifts toes.
    leg.ankle.rotation.x =
      -leg.hip.rotation.x * 0.35 - leg.knee.rotation.x * 0.45 + 0.18 * blend * Math.max(0, -swing);
  }

  private poseArm(arm: Arm, p: number, blend: number, run: number, armAmp: number, side: 1 | -1): void {
    const swing = Math.sin(p);
    // Positive pitch swings the hanging arm backward, so the arm counters
    // its own-side leg (which used -sin).
    arm.shoulder.rotation.x = armAmp * blend * swing;
    arm.shoulder.rotation.z = side * (0.08 + 0.1 * run * blend); // held slightly out
    // Elbows hang nearly straight at a walk, pump up when running,
    // and fold a touch more as the arm swings forward.
    const fwd = Math.max(0, -swing);
    arm.elbow.rotation.x = -(0.15 + 1.15 * run * blend + (0.25 + 0.4 * run) * blend * fwd);
  }
}
