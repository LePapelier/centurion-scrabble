/**
 * Choix du coup de l'adversaire.
 *
 * Tous les coups légaux sont d'abord énumérés, puis classés. Le niveau agit
 * sur quatre leviers indépendants :
 *   — le vocabulaire : aux deux premiers niveaux, seuls les mots qu'un joueur
 *     occasionnel connaît sont jouables. Le dictionnaire les marque d'un bit
 *     (voir `dawg.js` et `data/mots-courants.txt`) ; c'est ce qui sépare
 *     vraiment un débutant d'un joueur de club, bien plus que la longueur
 *     des mots ;
 *   — la part du meilleur coup visée (un débutant ne voit pas l'optimum) ;
 *   — l'appétit pour les coups qui posent beaucoup de tuiles : un débutant
 *     cherche à se débarrasser de ses lettres plutôt qu'à grappiller deux
 *     points dans un coin, et sans ce levier les parties duraient le double
 *     d'une partie réelle ;
 *   — la prise en compte du reliquat, c'est-à-dire la qualité du chevalet
 *     laissé pour le tour suivant.
 */
import { BLANK, RACK_SIZE } from './constants.js';
import { generateMoves } from './generator.js';

/* ------------------------------------------------------------------ */
/* Valeur du reliquat                                                  */
/* ------------------------------------------------------------------ */

const VOWELS = new Set([0, 4, 8, 14, 20]); // A E I O U

/** Utilité d'une lettre conservée, en points de score équivalents. */
const LEAVE_VALUE = new Float32Array([
  1.0, // A
  -1.0, // B
  -0.5, // C
  0.2, // D
  2.0, // E
  -2.0, // F
  -1.0, // G
  -2.0, // H
  0.5, // I
  -2.5, // J
  -3.0, // K
  0.5, // L
  0.0, // M
  1.2, // N
  0.2, // O
  -0.5, // P
  -6.0, // Q
  1.5, // R
  6.5, // S
  1.0, // T
  -1.0, // U
  -3.0, // V
  -4.0, // W
  -3.0, // X
  -3.0, // Y
  -3.0, // Z
  24.0, // joker
]);

/**
 * Note le chevalet restant après un coup : plus c'est haut, mieux on est
 * placé pour le tour suivant.
 * @param {number[]} rest indices de lettres conservées
 */
export function evaluateLeave(rest) {
  if (rest.length === 0) return 0;

  let value = 0;
  const counts = new Int32Array(27);
  for (const letter of rest) {
    value += LEAVE_VALUE[letter];
    counts[letter]++;
  }

  // Doublons : deux exemplaires passent encore, au-delà ça encombre.
  for (let letter = 0; letter < 26; letter++) {
    if (counts[letter] > 1) value -= (counts[letter] - 1) * 1.5;
    if (counts[letter] > 2) value -= (counts[letter] - 2) * 2;
  }

  // Q orphelin : pratiquement injouable sans U ni joker.
  if (counts[16] > 0 && counts[20] === 0 && counts[BLANK] === 0) value -= 4;

  // Équilibre voyelles / consonnes : l'idéal est 3 voyelles pour 4 consonnes.
  const vowels = rest.filter((l) => VOWELS.has(l)).length;
  const ideal = (rest.length * 3) / RACK_SIZE;
  value -= Math.abs(vowels - ideal) * 1.8;

  return value;
}

/** Retire d'un chevalet les tuiles consommées par un coup. */
export function remainingRack(rack, placements) {
  const rest = [...rack];
  for (const p of placements) {
    const wanted = p.blank ? BLANK : p.letter;
    const at = rest.indexOf(wanted);
    if (at >= 0) rest.splice(at, 1);
  }
  return rest;
}

/* ------------------------------------------------------------------ */
/* Choix du coup                                                       */
/* ------------------------------------------------------------------ */

/** Tirage normal centré réduit (Box–Muller). */
function gaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Partage le chevalet entre tuiles rendues au sac et tuiles conservées.
 * @returns {{drop: number[], keep: number[], value: number}}
 */
function chooseDiscard(rack, smart) {
  if (!smart) {
    const order = [...rack.keys()].sort(() => Math.random() - 0.5);
    const count = Math.max(1, Math.min(rack.length, 1 + Math.floor(Math.random() * 4)));
    const dropped = new Set(order.slice(0, count));
    const drop = [];
    const keep = [];
    rack.forEach((letter, i) => (dropped.has(i) ? drop : keep).push(letter));
    return { drop, keep, value: evaluateLeave(keep) };
  }

  let best = { drop: [rack[0]], keep: rack.slice(1), value: -Infinity };
  for (let mask = 0; mask < 1 << rack.length; mask++) {
    const keep = [];
    const drop = [];
    for (let i = 0; i < rack.length; i++) {
      if (mask & (1 << i)) keep.push(rack[i]);
      else drop.push(rack[i]);
    }
    if (drop.length === 0) continue;
    const value = evaluateLeave(keep);
    if (value > best.value) best = { drop, keep, value };
  }
  return best;
}

/**
 * Décide du coup de l'IA.
 *
 * @param {object} board
 * @param {number[]} rack
 * @param {import('./dawg.js').Dawg} dawg
 * @param {object} difficulty entrée de DIFFICULTIES
 * @param {{bagCount: number}} context
 * @returns {{type:'play', move:object}|{type:'exchange', tiles:number[]}|{type:'pass'}}
 */
export function chooseMove(board, rack, dawg, difficulty, context) {
  let moves = generateMoves(board, rack, dawg, {
    maxWordLength: difficulty.maxWordLength,
    maxTilesPlaced: difficulty.maxTilesPlaced,
  });

  const canExchange = context.bagCount >= RACK_SIZE;

  // Vocabulaire ordinaire : on écarte les coups reposant sur un mot court de
  // compétition.
  //
  // Quand il ne reste plus rien d'ordinaire — un Q sans U, par exemple — on
  // échange, ou on passe si le sac est trop maigre. Jamais on ne repêche le
  // mot pointu : c'est exactement là que la machine se trahissait, et un tour
  // blanc est un aveu bien plus crédible que WU.
  if (difficulty.vocabulaireCourant) {
    // Tous les mots formés doivent être ordinaires, y compris ceux qui
    // naissent perpendiculairement : poser MAISON en fabriquant OC au passage
    // suppose de savoir qu'OC existe.
    moves = moves.filter((move) => move.words.every((w) => dawg.estCourant(w.word)));
  }

  if (moves.length === 0) {
    if (canExchange) return { type: 'exchange', tiles: chooseDiscard(rack, difficulty.useLeave).drop };
    return { type: 'pass' };
  }

  const endgame = context.bagCount === 0;

  for (const move of moves) {
    let value = move.score;
    if (difficulty.useLeave && !endgame) {
      const rest = remainingRack(rack, move.placements);
      value += difficulty.leaveWeight * evaluateLeave(rest);

      // Un joker brûlé pour quelques points est un mauvais investissement.
      if (difficulty.keepBlank) {
        const blanksUsed = move.placements.filter((p) => p.blank).length;
        if (blanksUsed > 0 && !move.bingo) value -= blanksUsed * 12;
      }
    }
    if (endgame) {
      // En fin de partie, vider son chevalet prime.
      value += move.placements.length * 2;
    } else if (difficulty.tileBonus) {
      // Sans ce terme, viser une fraction du meilleur coup revient à jouer le
      // mot le plus court possible : c'est le moyen le plus simple d'atteindre
      // une cible basse. Le sac ne se vidait plus et la partie s'étirait sur
      // deux fois trop de tours.
      value += difficulty.tileBonus * move.placements.length;
    }
    move.value = value;
  }

  moves.sort((a, b) => b.value - a.value);

  // On ne vise pas un rang, mais une fraction du meilleur coup : le classement
  // des coups est très déséquilibré, alors qu'un objectif exprimé en points
  // reste lisible d'une position à l'autre.
  const ceiling = moves[0].value;
  let chosen = moves[0];
  if (difficulty.quality < 1 && ceiling > 0) {
    const aimed = Math.max(0.05, difficulty.quality * (1 + gaussian() * difficulty.spread));
    const target = ceiling * aimed;
    let bestGap = Infinity;
    for (const move of moves) {
      const gap = Math.abs(move.value - target);
      if (gap < bestGap) {
        bestGap = gap;
        chosen = move;
      }
    }
  }

  // Un coup dérisoire alors que le sac est plein : mieux vaut se refaire.
  if (canExchange && chosen.score < difficulty.exchangeThreshold && Math.random() < 0.6) {
    const playValue = chosen.score + evaluateLeave(remainingRack(rack, chosen.placements));
    const discard = chooseDiscard(rack, difficulty.useLeave);
    if (discard.value > playValue) return { type: 'exchange', tiles: discard.drop };
  }

  return { type: 'play', move: chosen };
}

/**
 * Le meilleur score atteignable depuis cette position, et le nombre de coups
 * légaux qui s'offraient.
 *
 * Sert à saluer un coup optimal. Le compte accompagne le score parce qu'on ne
 * félicite pas quelqu'un qui n'avait pas le choix : trouver le meilleur de
 * trois coups possibles n'est pas un exploit.
 */
export function bestScore(board, rack, dawg) {
  const moves = generateMoves(board, rack, dawg);
  let best = 0;
  for (const move of moves) if (move.score > best) best = move.score;
  return { score: best, count: moves.length };
}

/** Meilleur coup absolu — utilisé par le bouton « indice ». */
export function bestMove(board, rack, dawg) {
  const moves = generateMoves(board, rack, dawg);
  if (moves.length === 0) return null;
  let best = moves[0];
  for (const move of moves) if (move.score > best.score) best = move;
  return best;
}
