/**
 * Génération exhaustive des coups légaux (Appel & Jacobson, 1988).
 *
 * Principe : on ne considère que les cases vides adjacentes à une lettre déjà
 * posée (les « ancres »). Pour chaque ancre on construit la partie gauche du
 * mot en descendant dans le DAWG, puis on l'étend vers la droite en vérifiant
 * à chaque case que la lettre choisie forme aussi un mot perpendiculaire
 * valide (« contrôle croisé », précalculé une fois par coup).
 *
 * Le plateau est parcouru deux fois : tel quel pour les mots horizontaux, puis
 * transposé pour les verticaux.
 */
import { SIZE, CELLS, CENTER, BLANK } from './constants.js';
import { scorePlacements } from './board.js';

const ALL_LETTERS = (1 << 26) - 1;

/** Transpose les tableaux du plateau (ligne ↔ colonne). */
function transpose(letters, blanks) {
  const t = new Int8Array(CELLS);
  const b = new Uint8Array(CELLS);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      t[c * SIZE + r] = letters[r * SIZE + c];
      b[c * SIZE + r] = blanks[r * SIZE + c];
    }
  }
  return { letters: t, blanks: b };
}

/**
 * Masque des lettres L telles que `prefix + L + suffix` soit un mot.
 */
function crossMask(dawg, prefix, suffix) {
  const node = dawg.walk(dawg.root, prefix);
  if (node <= 0) return 0;
  let mask = 0;
  for (let edge = node; edge < dawg.edgeCount; edge++) {
    const letter = dawg.letterAt(edge);
    if (suffix.length === 0) {
      if (dawg.isWordEnd(edge)) mask |= 1 << letter;
    } else {
      const result = dawg.walkWithTerminal(dawg.child(edge), suffix);
      if (result && result.terminal) mask |= 1 << letter;
    }
    if (dawg.isLast(edge)) break;
  }
  return mask;
}

/**
 * Pour chaque case vide, les lettres qui y forment un mot vertical valide.
 * Une case sans voisin vertical accepte tout l'alphabet.
 */
function computeCrossChecks(dawg, letters) {
  const masks = new Int32Array(CELLS).fill(ALL_LETTERS);

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      if (letters[i] >= 0) continue;

      const prefix = [];
      for (let up = r - 1; up >= 0 && letters[up * SIZE + c] >= 0; up--) {
        prefix.unshift(letters[up * SIZE + c]);
      }
      const suffix = [];
      for (let down = r + 1; down < SIZE && letters[down * SIZE + c] >= 0; down++) {
        suffix.push(letters[down * SIZE + c]);
      }

      if (prefix.length === 0 && suffix.length === 0) continue;
      masks[i] = crossMask(dawg, prefix, suffix);
    }
  }
  return masks;
}

/** Cases vides jouables : adjacentes à une lettre posée. */
function computeAnchors(letters) {
  const anchors = new Uint8Array(CELLS);
  let occupied = false;
  for (let i = 0; i < CELLS; i++) if (letters[i] >= 0) { occupied = true; break; }

  if (!occupied) {
    anchors[CENTER] = 1;
    return anchors;
  }
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const i = r * SIZE + c;
      if (letters[i] >= 0) continue;
      if (
        (r > 0 && letters[i - SIZE] >= 0) ||
        (r < SIZE - 1 && letters[i + SIZE] >= 0) ||
        (c > 0 && letters[i - 1] >= 0) ||
        (c < SIZE - 1 && letters[i + 1] >= 0)
      ) {
        anchors[i] = 1;
      }
    }
  }
  return anchors;
}

/**
 * Tous les coups possibles depuis un plateau et un chevalet.
 *
 * @param {object} board  {letters, blanks}
 * @param {number[]} rack indices de lettres (26 = joker)
 * @param {import('./dawg.js').Dawg} dawg
 * @param {{maxWordLength?: number, maxTilesPlaced?: number}} [limits]
 * @returns {{placements: object[], score: number, words: object[], bingo: boolean}[]}
 */
export function generateMoves(board, rack, dawg, limits = {}) {
  const maxWordLength = limits.maxWordLength ?? SIZE;
  const maxTilesPlaced = limits.maxTilesPlaced ?? rack.length;

  const counts = new Int32Array(27);
  for (const letter of rack) counts[letter]++;

  /** @type {Map<string, object>} clé de pose → coup, pour dédoublonner. */
  const found = new Map();

  for (const flipped of [false, true]) {
    const view = flipped ? transpose(board.letters, board.blanks) : board;
    const masks = computeCrossChecks(dawg, view.letters);
    const anchors = computeAnchors(view.letters);

    const at = (r, c) => view.letters[r * SIZE + c];

    // La partie gauche est construite dans l'ordre du mot, mais sa colonne de
    // départ n'est connue qu'une fois sa longueur finale atteinte : on ne fixe
    // donc les colonnes qu'au moment d'enregistrer le coup.
    /** @type {{letter:number, blank:boolean}[]} */
    const left = [];
    /** @type {{col:number, letter:number, blank:boolean}[]} */
    const right = [];

    const record = (row, startCol, endCol) => {
      const count = left.length + right.length;
      if (count === 0 || count > maxTilesPlaced) return;
      if (endCol - startCol > maxWordLength) return;

      const placed = [
        ...left.map((tile, i) => ({ col: startCol + i, ...tile })),
        ...right,
      ];
      const placements = placed.map((p) => ({
        row: flipped ? p.col : row,
        col: flipped ? row : p.col,
        letter: p.letter,
        blank: p.blank,
      }));
      const key = placements
        .map((p) => `${p.row * SIZE + p.col}:${p.letter}${p.blank ? 'b' : ''}`)
        .sort()
        .join(',');
      if (found.has(key)) return;

      const scored = scorePlacements(board, placements);
      found.set(key, {
        placements,
        score: scored.total,
        words: scored.words,
        bingo: scored.bingo,
      });
    };

    /**
     * Étend le mot vers la droite depuis la colonne `col`.
     * `terminal` indique si le chemin parcouru forme déjà un mot complet.
     */
    const extendRight = (node, terminal, row, col, startCol) => {
      if (terminal && left.length + right.length > 0 && (col >= SIZE || at(row, col) < 0)) {
        record(row, startCol, col);
      }
      if (col >= SIZE || node === 0) return;

      const i = row * SIZE + col;
      const existing = at(row, col);

      if (existing >= 0) {
        const edge = dawg.edgeFor(node, existing);
        if (edge >= 0) extendRight(dawg.child(edge), dawg.isWordEnd(edge), row, col + 1, startCol);
        return;
      }

      if (left.length + right.length >= maxTilesPlaced) return;
      const allowed = masks[i];
      if (allowed === 0) return;

      for (let edge = node; edge < dawg.edgeCount; edge++) {
        const letter = dawg.letterAt(edge);
        const last = dawg.isLast(edge);
        if (allowed & (1 << letter)) {
          const next = dawg.child(edge);
          const terminalNext = dawg.isWordEnd(edge);
          if (counts[letter] > 0) {
            counts[letter]--;
            right.push({ col, letter, blank: false });
            extendRight(next, terminalNext, row, col + 1, startCol);
            right.pop();
            counts[letter]++;
          }
          if (counts[BLANK] > 0) {
            counts[BLANK]--;
            right.push({ col, letter, blank: true });
            extendRight(next, terminalNext, row, col + 1, startCol);
            right.pop();
            counts[BLANK]++;
          }
        }
        if (last) break;
      }
    };

    /**
     * Construit la partie gauche du mot, jusqu'à `limit` lettres avant l'ancre.
     * Les cases concernées sont vides et sans voisin perpendiculaire (sinon
     * elles seraient elles-mêmes des ancres) : aucun contrôle croisé n'y est
     * nécessaire.
     */
    const buildLeft = (node, row, anchorCol, limit) => {
      extendRight(node, false, row, anchorCol, anchorCol - left.length);
      if (limit === 0 || node === 0) return;
      if (left.length >= maxTilesPlaced) return;

      for (let edge = node; edge < dawg.edgeCount; edge++) {
        const letter = dawg.letterAt(edge);
        const last = dawg.isLast(edge);
        const next = dawg.child(edge);
        if (counts[letter] > 0) {
          counts[letter]--;
          left.push({ letter, blank: false });
          buildLeft(next, row, anchorCol, limit - 1);
          left.pop();
          counts[letter]++;
        }
        if (counts[BLANK] > 0) {
          counts[BLANK]--;
          left.push({ letter, blank: true });
          buildLeft(next, row, anchorCol, limit - 1);
          left.pop();
          counts[BLANK]++;
        }
        if (last) break;
      }
    };

    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) {
        if (!anchors[row * SIZE + col]) continue;

        if (col > 0 && at(row, col - 1) >= 0) {
          // Partie gauche imposée par les lettres déjà sur le plateau.
          let start = col - 1;
          while (start > 0 && at(row, start - 1) >= 0) start--;
          const prefix = [];
          for (let c = start; c < col; c++) prefix.push(at(row, c));
          const node = dawg.walk(dawg.root, prefix);
          if (node >= 0) extendRight(node, false, row, col, start);
        } else {
          let limit = 0;
          let c = col - 1;
          while (c >= 0 && at(row, c) < 0 && !anchors[row * SIZE + c]) {
            limit++;
            c--;
          }
          buildLeft(dawg.root, row, col, Math.min(limit, maxWordLength - 1));
        }
      }
    }
  }

  return [...found.values()].filter((move) => move.words.length > 0);
}
