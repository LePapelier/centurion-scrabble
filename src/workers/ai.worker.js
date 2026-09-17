/**
 * L'énumération des coups prend jusqu'à quelques centaines de millisecondes
 * sur un plateau chargé : elle se fait ici pour ne jamais figer l'interface.
 */
import { Dawg } from '../core/dawg.js';
import { chooseMove, bestMove } from '../core/ai.js';
import { difficultyByLevel } from '../core/constants.js';

/** @type {Dawg|null} */
let dawg = null;

function rebuildBoard(plain) {
  return { letters: Int8Array.from(plain.letters), blanks: Uint8Array.from(plain.blanks) };
}

self.onmessage = (event) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init': {
        dawg = new Dawg(message.buffer);
        self.postMessage({ type: 'ready', words: dawg.wordCount });
        break;
      }

      case 'move': {
        const started = performance.now();
        const decision = chooseMove(
          rebuildBoard(message.board),
          message.rack,
          dawg,
          difficultyByLevel(message.level),
          { bagCount: message.bagCount },
        );
        self.postMessage({ type: 'decision', id: message.id, decision, ms: performance.now() - started });
        break;
      }

      case 'hint': {
        const move = bestMove(rebuildBoard(message.board), message.rack, dawg);
        self.postMessage({ type: 'hint', id: message.id, move });
        break;
      }

      default:
        break;
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: message.id, message: String(error?.message ?? error) });
  }
};
