import { Game } from './core/Game';

const app = document.getElementById('app')!;
try {
  const game = await Game.create(app);
  game.start();

  // Debug handle for headless screenshot tooling.
  (window as unknown as { __game: Game }).__game = game;
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
