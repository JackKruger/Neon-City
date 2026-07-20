import { Game } from './core/Game';
import type { GameSaveV1 } from './save/GameSave';
import { SaveStorage } from './save/SaveStorage';
import { showStartupScreen } from './ui/StartupScreen';

const app = document.getElementById('app')!;
const saveStorage = SaveStorage.browser();
try {
  let initialSave: GameSaveV1 | undefined;
  let startupError = '';
  const stored = saveStorage.read();
  if (stored.ok) {
    while (true) {
      const choice = await showStartupScreen(app, saveStorage, stored.value, startupError);
      if (choice.kind === 'new') break;
      try {
        const game = await Game.create(app, choice.save, saveStorage);
        game.start();
        (window as unknown as { __game: Game }).__game = game;
        initialSave = choice.save;
        break;
      } catch (error) {
        startupError = `Continue failed: ${error instanceof Error ? error.message : String(error)}. Your save is unchanged.`;
        console.error('[boot] continue failed', error);
      }
    }
  } else if (stored.error.code !== 'missing' && stored.error.code !== 'unavailable') {
    console.warn(`[save] ${stored.error.message}`);
  }
  if (!initialSave) {
    const game = await Game.create(app, undefined, saveStorage);
    game.start();
    (window as unknown as { __game: Game }).__game = game;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[boot] game failed to start', error);
  const diagnostic = document.createElement('div');
  diagnostic.textContent = `Neon Bay could not start: ${message}`;
  Object.assign(diagnostic.style, {
    margin: '24px', padding: '18px', color: '#fff', background: '#420b21',
    border: '1px solid #ff5f9e', font: '16px monospace', whiteSpace: 'pre-wrap',
  });
  app.replaceChildren(diagnostic);
}
