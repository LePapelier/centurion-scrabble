/**
 * État du plateau et calcul des scores.
 *
 * Le plateau est stocké à plat : `letters[i]` vaut -1 si la case est vide,
 * sinon l'index de la lettre posée (A=0 … Z=25). `blanks[i]` vaut 1 si le
 * jeton posé est un joker — il compte alors pour 0 point.
 */
import {
  SIZE,
  CELLS,
  CENTER,
  PREMIUMS,
  LETTER_MULTIPLIER,
  WORD_MULTIPLIER,
  VALUES,
  BINGO_BONUS,
  RACK_SIZE,
} from './constants.js';

export function createBoard() {
  return { letters: new Int8Array(CELLS).fill(-1), blanks: new Uint8Array(CELLS) };
}

export function cloneBoard(board) {
  return { letters: Int8Array.from(board.letters), blanks: Uint8Array.from(board.blanks) };
}

export function isEmptyBoard(board) {
  return board.letters.every((l) => l < 0);
}

export const HORIZONTAL = 0;
export const VERTICAL = 1;

const STEP = [1, SIZE];

/**
 * Applique des poses sur un plateau (mutation).
 * @param {{row:number, col:number, letter:number, blank:boolean}[]} placements
 */
export function applyPlacements(board, placements) {
  for (const p of placements) {
    const i = p.row * SIZE + p.col;
    board.letters[i] = p.letter;
    board.blanks[i] = p.blank ? 1 : 0;
  }
  return board;
}

/**
 * Vérifie la géométrie d'une pose, indépendamment du dictionnaire.
 * @returns {{ok: true, direction: number} | {ok: false, reason: string}}
 */
export function checkGeometry(board, placements) {
  if (placements.length === 0) return { ok: false, reason: 'Aucune lettre posée.' };

  const seen = new Set();
  for (const p of placements) {
    const i = p.row * SIZE + p.col;
    if (board.letters[i] >= 0) return { ok: false, reason: 'Une case est déjà occupée.' };
    if (seen.has(i)) return { ok: false, reason: 'Deux jetons sur la même case.' };
    seen.add(i);
  }

  const rows = new Set(placements.map((p) => p.row));
  const cols = new Set(placements.map((p) => p.col));
  if (rows.size > 1 && cols.size > 1) {
    return { ok: false, reason: 'Les lettres doivent être alignées.' };
  }
  const direction = rows.size === 1 ? HORIZONTAL : VERTICAL;
  const step = STEP[direction];

  // Contiguïté : entre la première et la dernière case posée, aucun trou.
  const indices = [...seen].sort((a, b) => a - b);
  for (let i = indices[0]; i <= indices[indices.length - 1]; i += step) {
    if (!seen.has(i) && board.letters[i] < 0) {
      return { ok: false, reason: 'Le mot est interrompu par une case vide.' };
    }
  }

  const empty = isEmptyBoard(board);
  if (empty) {
    if (!seen.has(CENTER)) return { ok: false, reason: 'Le premier mot doit passer par la case centrale.' };
    if (placements.length < 2) return { ok: false, reason: 'Le premier mot doit faire au moins deux lettres.' };
  } else {
    const touches = placements.some((p) => hasNeighbour(board, p.row, p.col));
    if (!touches) return { ok: false, reason: 'Le mot doit toucher une lettre déjà posée.' };
  }

  return { ok: true, direction };
}

function hasNeighbour(board, row, col) {
  if (row > 0 && board.letters[(row - 1) * SIZE + col] >= 0) return true;
  if (row < SIZE - 1 && board.letters[(row + 1) * SIZE + col] >= 0) return true;
  if (col > 0 && board.letters[row * SIZE + col - 1] >= 0) return true;
  if (col < SIZE - 1 && board.letters[row * SIZE + col + 1] >= 0) return true;
  return false;
}

/**
 * Remonte jusqu'au début du mot contenant `index` dans une direction.
 */
function wordStart(letters, index, direction) {
  const step = STEP[direction];
  let start = index;
  while (true) {
    const previous = start - step;
    if (previous < 0) break;
    if (direction === HORIZONTAL && Math.floor(previous / SIZE) !== Math.floor(start / SIZE)) break;
    if (letters[previous] < 0) break;
    start = previous;
  }
  return start;
}

function wordCells(letters, start, direction) {
  const step = STEP[direction];
  const cells = [];
  let i = start;
  while (i < CELLS && letters[i] >= 0) {
    cells.push(i);
    const next = i + step;
    if (direction === HORIZONTAL && Math.floor(next / SIZE) !== Math.floor(i / SIZE)) break;
    i = next;
  }
  return cells;
}

/**
 * Tous les mots formés par une pose, avec leur score.
 *
 * @returns {{
 *   total: number,
 *   bingo: boolean,
 *   words: {word: string, cells: number[], score: number, direction: number}[]
 * }}
 */
export function scorePlacements(board, placements) {
  const letters = Int8Array.from(board.letters);
  const blanks = Uint8Array.from(board.blanks);
  const fresh = new Set();

  for (const p of placements) {
    const i = p.row * SIZE + p.col;
    letters[i] = p.letter;
    blanks[i] = p.blank ? 1 : 0;
    fresh.add(i);
  }

  const words = [];
  const seenStarts = new Set();

  for (const index of fresh) {
    for (const direction of [HORIZONTAL, VERTICAL]) {
      const start = wordStart(letters, index, direction);
      const key = start * 2 + direction;
      if (seenStarts.has(key)) continue;
      seenStarts.add(key);

      const cells = wordCells(letters, start, direction);
      if (cells.length < 2) continue;

      let score = 0;
      let multiplier = 1;
      let text = '';
      for (const cell of cells) {
        const value = blanks[cell] ? 0 : VALUES[letters[cell]];
        const premium = PREMIUMS[cell];
        if (fresh.has(cell)) {
          score += value * LETTER_MULTIPLIER[premium];
          multiplier *= WORD_MULTIPLIER[premium];
        } else {
          score += value;
        }
        text += String.fromCharCode(65 + letters[cell]);
      }
      words.push({ word: text, cells, score: score * multiplier, direction });
    }
  }

  const bingo = placements.length === RACK_SIZE;
  const total = words.reduce((sum, w) => sum + w.score, 0) + (bingo ? BINGO_BONUS : 0);
  return { total, bingo, words };
}

/**
 * Validation complète d'un coup humain : géométrie, puis dictionnaire.
 *
 * @returns {{ok: true, score: number, bingo: boolean, words: object[]}
 *          |{ok: false, reason: string, invalid?: string[]}}
 */
export function validateMove(board, placements, dawg) {
  const geometry = checkGeometry(board, placements);
  if (!geometry.ok) return geometry;

  const scored = scorePlacements(board, placements);
  if (scored.words.length === 0) {
    return { ok: false, reason: 'Une lettre seule ne forme pas de mot.' };
  }

  const invalid = scored.words.filter((w) => !dawg.has(w.word)).map((w) => w.word);
  if (invalid.length > 0) {
    const label = invalid.length === 1 ? 'Mot refusé' : 'Mots refusés';
    return { ok: false, reason: `${label} : ${invalid.join(', ')}.`, invalid };
  }

  return { ok: true, score: scored.total, bingo: scored.bingo, words: scored.words };
}
