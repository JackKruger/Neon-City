import type { GameSaveV1 } from '../save/GameSave';
import type { SaveStorage } from '../save/SaveStorage';

export type StartupChoice = { kind: 'continue'; save: GameSaveV1 } | { kind: 'new' };

export function showStartupScreen(
  container: HTMLElement,
  storage: SaveStorage,
  save: GameSaveV1,
  error = ''
): Promise<StartupChoice> {
  return new Promise((resolve) => {
    const root = document.createElement('main');
    root.setAttribute('aria-labelledby', 'startup-title');
    Object.assign(root.style, {
      minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '14px', padding: '24px', boxSizing: 'border-box', color: '#fff', background: '#120b27', fontFamily: 'sans-serif',
    });
    root.innerHTML = `
      <h1 id="startup-title" style="margin:0;color:#ff5db1;font-size:clamp(38px,8vw,72px);text-shadow:0 0 20px #ff3cac">NEON BAY</h1>
      <p style="margin:0;color:#74ffd1">Saved ${new Date(save.savedAt).toLocaleString()}</p>
      <p role="alert" style="min-height:1.3em;margin:0;color:#ff9ac8"></p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
        <button type="button" data-choice="continue">Continue</button>
        <button type="button" data-choice="new">New Game</button>
      </div>
      <p style="opacity:.62;font-size:13px">Tab / arrows to choose · Enter / A to select</p>`;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
    root.querySelector<HTMLElement>('[role="alert"]')!.textContent = error;
    for (const button of buttons) Object.assign(button.style, {
      minWidth: '150px', padding: '13px 20px', borderRadius: '8px', border: '1px solid #5ef3ff',
      background: '#261847', color: '#fff', fontSize: '18px', fontWeight: '700', cursor: 'pointer',
    });
    container.replaceChildren(root);
    let selected = 0;
    let previousGamepad = false;
    let frame = 0;
    const focus = () => buttons[selected].focus();
    const finish = (choice: StartupChoice) => {
      cancelAnimationFrame(frame);
      root.removeEventListener('keydown', onKey);
      resolve(choice);
    };
    const choose = (kind: string | undefined) => {
      if (kind === 'continue') finish({ kind: 'continue', save });
      if (kind === 'new') {
        if (!window.confirm('Start a new game and permanently replace the existing save?')) return;
        const deleted = storage.delete();
        if (!deleted.ok) {
          root.querySelector<HTMLElement>('[role="alert"]')!.textContent = deleted.error.message;
          return;
        }
        finish({ kind: 'new' });
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        selected = selected === 0 ? 1 : 0;
        focus();
      }
    };
    root.addEventListener('keydown', onKey);
    for (const button of buttons) button.addEventListener('click', () => choose(button.dataset.choice));
    const pollGamepad = () => {
      const pad = navigator.getGamepads?.()[0];
      const directional = Boolean(pad && (Math.abs(pad.axes[0] ?? 0) > 0.6 || pad.buttons[14]?.pressed || pad.buttons[15]?.pressed));
      if (directional && !previousGamepad) {
        selected = selected === 0 ? 1 : 0;
        focus();
      }
      const accept = Boolean(pad?.buttons[0]?.pressed);
      if (accept && !previousGamepad) choose(buttons[selected].dataset.choice);
      previousGamepad = directional || accept;
      frame = requestAnimationFrame(pollGamepad);
    };
    focus();
    frame = requestAnimationFrame(pollGamepad);
  });
}
