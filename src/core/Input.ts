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
  sprint: boolean;
  /** Edge-triggered (true for exactly one fixed step). */
  interact: boolean;
  pause: boolean;
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
    sprint: false,
    interact: false,
    pause: false,
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
  private pendingInteract = [false, false];
  private pendingPause = [false, false];

  p1Pad: number | null = null;
  p2Pad: number | null = null;
  p2JoinRequested = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keyEdges.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.p1Pad === e.gamepad.index) this.p1Pad = null;
      if (this.p2Pad === e.gamepad.index) this.p2Pad = null;
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
        if (just(3)) this.pendingInteract[player] = true;
        if (just(9)) this.pendingPause[player] = true;
      }
      this.padPrev.set(pad.index, pressed);
    }

    if (this.keyEdges.has('KeyE')) this.pendingInteract[0] = true;
    if (this.keyEdges.has('Escape')) this.pendingPause[0] = true;
    this.keyEdges.clear();
  }

  /** Drop queued interact presses (e.g. accumulated on the pause screen). */
  clearInteract(): void {
    this.pendingInteract[0] = this.pendingInteract[1] = false;
  }

  /** True once if any player pressed pause since the last call. */
  consumePause(): boolean {
    const hit = this.pendingPause[0] || this.pendingPause[1];
    this.pendingPause[0] = this.pendingPause[1] = false;
    return hit;
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
    input.interact = this.pendingInteract[player];
    input.pause = this.pendingPause[player];
    this.pendingInteract[player] = false;
    this.pendingPause[player] = false;
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
    input.sprint = input.sprint || (pad.buttons[0]?.pressed ?? false);
  }
}
