/** Per-player input snapshot, consumed once per fixed step. */
export interface PlayerInput {
  /** On-foot movement, camera-relative. x: strafe right, y: forward. -1..1 */
  moveX: number;
  moveY: number;
  /** Driving: -1 (left) .. 1 (right) */
  steer: number;
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  handbrake: boolean;
  /** Aircraft descent (Shift on keyboard, B/Circle on gamepad). */
  descend: boolean;
  sprint: boolean;
  /** Held: fire/swing (auto weapons keep attacking while held). */
  attack: boolean;
  /** Held: aim the equipped gun toward the camera direction. */
  aim: boolean;
  /** Edge-triggered (true for exactly one fixed step). */
  jump: boolean;
  interact: boolean;
  pause: boolean;
  attackPressed: boolean;
  weaponNext: boolean;
  weaponPrev: boolean;
  reload: boolean;
}

export type InputMethod = 'keyboard' | 'gamepad';

export interface CameraInput {
  /** Orbit deltas in radians for this render frame. */
  yaw: number;
  pitch: number;
  recenter: boolean;
}

const DEADZONE = 0.15;

function dz(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

function emptyInput(): PlayerInput {
  return {
    moveX: 0,
    moveY: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: false,
    descend: false,
    sprint: false,
    attack: false,
    aim: false,
    jump: false,
    interact: false,
    pause: false,
    attackPressed: false,
    weaponNext: false,
    weaponPrev: false,
    reload: false,
  };
}

/**
 * Keyboard always drives player 1 (a gamepad can also claim P1 by pressing
 * A/B/X/Y while unclaimed). Pressing Start on an unclaimed gamepad requests
 * a player-2 join, which Game picks up via `p2JoinRequested`.
 */
export class Input {
  private keys = new Set<string>();
  private keyEdges = new Set<string>();
  private padPrev = new Map<number, boolean[]>();
  /** Edge flags accumulated between fixed steps, keyed by player (0/1). */
  private pendingJump = [false, false];
  private pendingInteract = [false, false];
  private pendingPause = [false, false];
  private pendingAttack = [false, false];
  private pendingWeaponNext = [false, false];
  private pendingWeaponPrev = [false, false];
  private pendingReload = [false, false];
  private pendingCameraReset = [false, false];
  private pendingMap = false;
  private mouseButtons = new Set<number>();
  private mouseLookX = 0;
  private mouseLookY = 0;
  private methods: [InputMethod, InputMethod] = ['keyboard', 'gamepad'];

  p1Pad: number | null = null;
  p2Pad: number | null = null;
  p2JoinRequested = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault(); // weapon cycle, keep browser focus
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keyEdges.add(e.code);
      this.methods[0] = 'keyboard';
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    // Mouse always drives player 1: left fires, right aims.
    window.addEventListener('mousedown', (e) => {
      this.mouseButtons.add(e.button);
      if (e.button === 0) this.pendingAttack[0] = true;
      this.methods[0] = 'keyboard';
    });
    window.addEventListener('mousemove', (e) => {
      if (!document.pointerLockElement) return;
      this.mouseLookX += e.movementX;
      this.mouseLookY += e.movementY;
      if (e.movementX !== 0 || e.movementY !== 0) this.methods[0] = 'keyboard';
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseButtons.clear();
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.p1Pad === e.gamepad.index) this.p1Pad = null;
      if (this.p2Pad === e.gamepad.index) this.p2Pad = null;
    });
  }

  /** Capture relative mouse movement while playing; Esc releases it normally. */
  attachPointerLock(element: HTMLElement): void {
    element.addEventListener('mousedown', () => {
      if (!document.pointerLockElement) void element.requestPointerLock();
    });
  }

  /** Call once per render frame to poll gamepads and accumulate edges. */
  poll(): void {
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      const prev = this.padPrev.get(pad.index) ?? [];
      const pressed = pad.buttons.map((b) => b.pressed);
      const just = (i: number) => pressed[i] && !prev[i];

      const claimed = pad.index === this.p1Pad || pad.index === this.p2Pad;
      if (!claimed) {
        if (just(9) && this.p2Pad === null) {
          this.p2Pad = pad.index;
          this.p2JoinRequested = true;
        } else if ((just(0) || just(1) || just(2) || just(3)) && this.p1Pad === null) {
          this.p1Pad = pad.index;
        }
      } else {
        const player = pad.index === this.p1Pad ? 0 : 1;
        if (just(0)) this.pendingJump[player] = true;
        if (just(3)) this.pendingInteract[player] = true;
        if (just(9)) this.pendingPause[player] = true;
        if (just(8)) this.pendingMap = true;
        // RT doubles as throttle while driving; Player ignores attacks in cars.
        if (just(7)) this.pendingAttack[player] = true;
        if (just(5)) this.pendingWeaponNext[player] = true;
        if (just(4)) this.pendingWeaponPrev[player] = true;
        if (just(2)) this.pendingReload[player] = true;
        if (just(11)) this.pendingCameraReset[player] = true;
        const activeAxis = pad.axes.some((axis) => Math.abs(axis) > DEADZONE);
        if (pressed.some(Boolean) || activeAxis) this.methods[player] = 'gamepad';
      }
      this.padPrev.set(pad.index, pressed);
    }

    if (this.keyEdges.has('Space')) this.pendingJump[0] = true;
    if (this.keyEdges.has('KeyE')) this.pendingInteract[0] = true;
    if (this.keyEdges.has('Escape')) this.pendingPause[0] = true;
    if (this.keyEdges.has('KeyM')) this.pendingMap = true;
    if (this.keyEdges.has('KeyF')) this.pendingAttack[0] = true;
    if (this.keyEdges.has('KeyC') || this.keyEdges.has('Tab')) this.pendingWeaponNext[0] = true;
    if (this.keyEdges.has('KeyQ')) this.pendingWeaponPrev[0] = true;
    if (this.keyEdges.has('KeyR')) this.pendingReload[0] = true;
    if (this.keyEdges.has('KeyV')) this.pendingCameraReset[0] = true;
    this.keyEdges.clear();
  }

  /** Mouse/right-stick camera orbit for one player. */
  cameraInput(
    player: 0 | 1,
    dt: number,
    sensitivity: number,
    invertY: boolean,
    enabled = true
  ): CameraInput {
    let yaw = 0;
    let pitch = 0;
    if (enabled && player === 0) {
      yaw += this.mouseLookX * 0.0025 * sensitivity;
      pitch += this.mouseLookY * 0.002 * sensitivity;
    }
    if (enabled) {
      const padIndex = player === 0 ? this.p1Pad : this.p2Pad;
      const pad = padIndex === null ? null : navigator.getGamepads()[padIndex];
      if (pad) {
        yaw += dz(pad.axes[2] ?? 0) * 2.4 * dt * sensitivity;
        pitch += dz(pad.axes[3] ?? 0) * 1.8 * dt * sensitivity;
      }
    }
    if (player === 0) {
      this.mouseLookX = 0;
      this.mouseLookY = 0;
    }
    if (invertY) pitch *= -1;
    const recenter = this.pendingCameraReset[player];
    this.pendingCameraReset[player] = false;
    return { yaw, pitch, recenter };
  }

  inputMethod(player: 0 | 1): InputMethod {
    return this.methods[player];
  }

  interactLabel(player: 0 | 1): string {
    return this.methods[player] === 'gamepad' ? 'Y' : 'E';
  }

  /** Drop queued gameplay presses (e.g. accumulated on the pause screen). */
  clearGameplayEdges(): void {
    this.pendingJump[0] = this.pendingJump[1] = false;
    this.pendingInteract[0] = this.pendingInteract[1] = false;
    this.pendingAttack[0] = this.pendingAttack[1] = false;
    this.pendingWeaponNext[0] = this.pendingWeaponNext[1] = false;
    this.pendingWeaponPrev[0] = this.pendingWeaponPrev[1] = false;
    this.pendingReload[0] = this.pendingReload[1] = false;
  }

  /** True once if any player pressed pause since the last call. */
  consumePause(): boolean {
    const hit = this.pendingPause[0] || this.pendingPause[1];
    this.pendingPause[0] = this.pendingPause[1] = false;
    return hit;
  }

  /** True once if M or Back/Select was pressed since the last call. */
  consumeMapToggle(): boolean {
    const hit = this.pendingMap;
    this.pendingMap = false;
    return hit;
  }

  /** Full-map pan axes. Arrow keys and d-pad stay separate from movement controls. */
  mapPanAxes(): { x: number; y: number } {
    let x = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
    let y = (this.keys.has('ArrowDown') ? 1 : 0) - (this.keys.has('ArrowUp') ? 1 : 0);
    for (const padIndex of [this.p1Pad, this.p2Pad]) {
      if (padIndex === null) continue;
      const pad = navigator.getGamepads()[padIndex];
      if (!pad) continue;
      x += (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0);
      y += (pad.buttons[13]?.pressed ? 1 : 0) - (pad.buttons[12]?.pressed ? 1 : 0);
    }
    return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  /** Build the input snapshot for a player and clear their edge flags. */
  read(player: 0 | 1): PlayerInput {
    const input = emptyInput();
    if (player === 0) this.readKeyboard(input);
    const padIndex = player === 0 ? this.p1Pad : this.p2Pad;
    if (padIndex !== null) {
      const pad = navigator.getGamepads()[padIndex];
      if (pad) this.readPad(pad, input);
    }
    input.jump = this.pendingJump[player];
    input.interact = this.pendingInteract[player];
    input.pause = this.pendingPause[player];
    input.attackPressed = this.pendingAttack[player];
    input.weaponNext = this.pendingWeaponNext[player];
    input.weaponPrev = this.pendingWeaponPrev[player];
    input.reload = this.pendingReload[player];
    this.pendingJump[player] = false;
    this.pendingInteract[player] = false;
    this.pendingPause[player] = false;
    this.pendingAttack[player] = false;
    this.pendingWeaponNext[player] = false;
    this.pendingWeaponPrev[player] = false;
    this.pendingReload[player] = false;
    return input;
  }

  private readKeyboard(input: PlayerInput): void {
    const k = this.keys;
    const right = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    input.moveX = right;
    input.moveY = fwd;
    input.steer = right;
    input.throttle = k.has('KeyW') ? 1 : 0;
    input.brake = k.has('KeyS') ? 1 : 0;
    input.handbrake = k.has('Space');
    input.sprint = k.has('ShiftLeft') || k.has('ShiftRight');
    input.descend = input.sprint;
    input.attack = k.has('KeyF') || this.mouseButtons.has(0);
    input.aim = this.mouseButtons.has(2);
  }

  private readPad(pad: Gamepad, input: PlayerInput): void {
    const lx = dz(pad.axes[0] ?? 0);
    const ly = dz(pad.axes[1] ?? 0);
    input.moveX = input.moveX || lx;
    input.moveY = input.moveY || -ly;
    input.steer = input.steer || lx;
    input.throttle = Math.max(input.throttle, pad.buttons[7]?.value ?? 0);
    input.brake = Math.max(input.brake, pad.buttons[6]?.value ?? 0);
    input.handbrake = input.handbrake || (pad.buttons[0]?.pressed ?? false);
    input.descend = input.descend || (pad.buttons[1]?.pressed ?? false);
    input.sprint = input.sprint || (pad.buttons[0]?.pressed ?? false);
    input.attack = input.attack || (pad.buttons[7]?.pressed ?? false);
    input.aim = input.aim || (pad.buttons[6]?.pressed ?? false);
  }
}
