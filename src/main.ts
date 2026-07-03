import { Game } from './core/Game';

const app = document.getElementById('app')!;
const game = await Game.create(app);
game.start();

// Debug handle for headless screenshot tooling.
(window as unknown as { __game: Game }).__game = game;
