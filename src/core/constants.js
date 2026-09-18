/** Règles chiffrées du Scrabble francophone. */

export const SIZE = 15;
export const CELLS = SIZE * SIZE;
export const CENTER = 7 * SIZE + 7; // case H8
export const RACK_SIZE = 7;
export const BINGO_BONUS = 50;
export const BLANK = 26; // index réservé au joker dans les chevalets

/** Cases multiplicatrices. */
export const NORMAL = 0;
export const DOUBLE_LETTER = 1;
export const TRIPLE_LETTER = 2;
export const DOUBLE_WORD = 3;
export const TRIPLE_WORD = 4;

const PREMIUM_LAYOUT = [
  'T..d...T...d..T',
  '.D...t...t...D.',
  '..D...d.d...D..',
  'd..D...d...D..d',
  '....D.....D....',
  '.t...t...t...t.',
  '..d...d.d...d..',
  'T..d...D...d..T',
  '..d...d.d...d..',
  '.t...t...t...t.',
  '....D.....D....',
  'd..D...d...D..d',
  '..D...d.d...D..',
  '.D...t...t...D.',
  'T..d...T...d..T',
];

const PREMIUM_CODES = { '.': NORMAL, d: DOUBLE_LETTER, t: TRIPLE_LETTER, D: DOUBLE_WORD, T: TRIPLE_WORD };

/** @type {Uint8Array} une entrée par case, dans l'ordre ligne puis colonne. */
export const PREMIUMS = (() => {
  const grid = new Uint8Array(CELLS);
  PREMIUM_LAYOUT.forEach((row, r) => {
    for (let c = 0; c < SIZE; c++) grid[r * SIZE + c] = PREMIUM_CODES[row[c]];
  });
  return grid;
})();

export const LETTER_MULTIPLIER = { [NORMAL]: 1, [DOUBLE_LETTER]: 2, [TRIPLE_LETTER]: 3, [DOUBLE_WORD]: 1, [TRIPLE_WORD]: 1 };
export const WORD_MULTIPLIER = { [NORMAL]: 1, [DOUBLE_LETTER]: 1, [TRIPLE_LETTER]: 1, [DOUBLE_WORD]: 2, [TRIPLE_WORD]: 3 };

/** Valeur de chaque lettre, index 0 = A … 25 = Z, 26 = joker. */
export const VALUES = new Uint8Array([
  1, // A
  3, // B
  3, // C
  2, // D
  1, // E
  4, // F
  2, // G
  4, // H
  1, // I
  8, // J
  10, // K
  1, // L
  2, // M
  1, // N
  1, // O
  3, // P
  8, // Q
  1, // R
  1, // S
  1, // T
  1, // U
  4, // V
  10, // W
  10, // X
  10, // Y
  10, // Z
  0, // joker
]);

/** Distribution officielle : 102 jetons, dont 2 jokers. */
export const DISTRIBUTION = new Uint8Array([
  9, // A
  2, // B
  2, // C
  3, // D
  15, // E
  2, // F
  2, // G
  2, // H
  8, // I
  1, // J
  1, // K
  5, // L
  3, // M
  6, // N
  6, // O
  2, // P
  1, // Q
  6, // R
  6, // S
  6, // T
  6, // U
  2, // V
  1, // W
  1, // X
  1, // Y
  1, // Z
  2, // joker
]);

export const TOTAL_TILES = DISTRIBUTION.reduce((sum, n) => sum + n, 0); // 102

/** A=0 … Z=25, joker=26 → caractère affiché. */
export function letterChar(index) {
  return index === BLANK ? '?' : String.fromCharCode(65 + index);
}

/** Caractère → index, ou -1. */
export function letterIndex(char) {
  if (char === '?') return BLANK;
  const code = char.toUpperCase().charCodeAt(0) - 65;
  return code >= 0 && code <= 25 ? code : -1;
}

export function coordName(index) {
  const row = Math.floor(index / SIZE);
  const col = index % SIZE;
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

/**
 * Les cinq niveaux de l'adversaire.
 *
 * `quality` est la fraction visée du meilleur coup disponible : c'est le
 * levier principal. `spread` est l'écart-type relatif appliqué à cette cible,
 * qui rend le jeu moins mécanique. Les bornes de longueur simulent en plus un
 * vocabulaire limité aux niveaux bas.
 */
export const DIFFICULTIES = [
  {
    level: 1,
    name: 'Novice',
    blurb: 'Mots courts, coups timides.',
    maxWordLength: 5,
    maxTilesPlaced: 4,
    quality: 0.30,
    spread: 0.26,
    useLeave: false,
    keepBlank: false,
    exchangeThreshold: 5,
  },
  {
    level: 2,
    name: 'Amateur',
    blurb: 'Joue juste, rate les gros coups.',
    maxWordLength: 7,
    maxTilesPlaced: 5,
    quality: 0.44,
    spread: 0.2,
    useLeave: true,
    leaveWeight: 0.25,
    keepBlank: false,
    exchangeThreshold: 8,
  },
  {
    level: 3,
    name: 'Confirmé',
    blurb: 'Connaît tous les mots, calcule peu.',
    maxWordLength: 15,
    maxTilesPlaced: 7,
    quality: 0.60,
    spread: 0.14,
    useLeave: true,
    leaveWeight: 0.5,
    keepBlank: false,
    exchangeThreshold: 11,
  },
  {
    level: 4,
    name: 'Expert',
    blurb: 'Vise le maximum, garde ses bonnes lettres.',
    maxWordLength: 15,
    maxTilesPlaced: 7,
    quality: 0.80,
    spread: 0.07,
    useLeave: true,
    leaveWeight: 0.85,
    keepBlank: true,
    exchangeThreshold: 14,
  },
  {
    level: 5,
    name: 'Centurion',
    blurb: 'Ne laisse rien passer.',
    maxWordLength: 15,
    maxTilesPlaced: 7,
    quality: 1,
    spread: 0,
    useLeave: true,
    leaveWeight: 1,
    keepBlank: true,
    exchangeThreshold: 18,
  },
];

export function difficultyByLevel(level) {
  return DIFFICULTIES.find((d) => d.level === level) ?? DIFFICULTIES[2];
}
