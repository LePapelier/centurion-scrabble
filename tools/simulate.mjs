#!/usr/bin/env node
/**
 * Parties automatiques niveau contre niveau : vérifie que le moteur ne bloque
 * pas, que tous les mots posés sont au dictionnaire, et donne une idée du
 * niveau réel de chaque palier.
 *
 *   node tools/simulate.mjs [parties par affiche]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dawg } from '../src/core/dawg.js';
import { Game, HUMAN, COMPUTER } from '../src/core/game.js';
import { chooseMove } from '../src/core/ai.js';
import { difficultyByLevel, SIZE } from '../src/core/constants.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(ROOT, 'public', 'dict', 'fr.dawg'));
const dawg = new Dawg(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

const ROUNDS = Number(process.argv[2] ?? 12);

/** Joue une partie complète entre deux niveaux. */
function playGame(levelA, levelB) {
  const game = new Game({ level: levelA });
  const levels = { [HUMAN]: difficultyByLevel(levelA), [COMPUTER]: difficultyByLevel(levelB) };
  let turns = 0;
  let generationMs = 0;
  let maxTurnMs = 0;

  while (!game.finished && turns < 200) {
    const player = game.currentPlayer;
    const started = performance.now();
    const decision = chooseMove(game.board, player.rack, dawg, levels[game.current], {
      bagCount: game.bagCount,
    });
    const elapsed = performance.now() - started;
    generationMs += elapsed;
    maxTurnMs = Math.max(maxTurnMs, elapsed);

    if (decision.type === 'play') {
      // Contrôle indépendant : chaque mot formé doit être au dictionnaire.
      for (const word of decision.move.words) {
        if (!dawg.has(word.word)) throw new Error(`Mot invalide généré : ${word.word}`);
      }
      const result = game.play(decision.move.placements, dawg);
      if (!result.ok) throw new Error(`Coup rejeté par le moteur : ${result.reason}`);
      if (result.score !== decision.move.score) {
        throw new Error(`Score incohérent : ${result.score} ≠ ${decision.move.score}`);
      }
    } else if (decision.type === 'exchange') {
      const result = game.exchange(decision.tiles);
      if (!result.ok) game.pass();
    } else {
      game.pass();
    }
    turns++;
  }

  // Invariant : 102 tuiles au total, où qu'ils soient.
  const onBoard = [...game.board.letters].filter((l) => l >= 0).length;
  const inRacks = game.players.reduce((sum, p) => sum + p.rack.length, 0);
  const total = onBoard + inRacks + game.bagCount;
  if (total !== 102) throw new Error(`Tuiles perdus : ${total} au lieu de 102`);

  return {
    scoreA: game.players[HUMAN].score,
    scoreB: game.players[COMPUTER].score,
    turns,
    finished: game.finished,
    avgMs: generationMs / Math.max(turns, 1),
    maxTurnMs,
  };
}

console.log(`Simulation : ${ROUNDS} parties par affiche\n`);

const pairs = [
  [1, 1],
  [1, 3],
  [2, 4],
  [3, 3],
  [3, 5],
  [4, 5],
  [5, 5],
];

let worstTurn = 0;
for (const [a, b] of pairs) {
  let winsA = 0;
  let sumA = 0;
  let sumB = 0;
  let sumTurns = 0;
  let sumAvg = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const result = playGame(a, b);
    if (result.scoreA > result.scoreB) winsA++;
    sumA += result.scoreA;
    sumB += result.scoreB;
    sumTurns += result.turns;
    sumAvg += result.avgMs;
    worstTurn = Math.max(worstTurn, result.maxTurnMs);
  }
  const f = (n) => n.toFixed(0).padStart(4);
  console.log(
    `niveau ${a} vs ${b} : ${f(sumA / ROUNDS)} — ${f(sumB / ROUNDS)}   ` +
      `victoires ${String(winsA).padStart(2)}/${ROUNDS}   ` +
      `${(sumTurns / ROUNDS).toFixed(0)} tours   ${(sumAvg / ROUNDS).toFixed(0)} ms/coup`,
  );
}

console.log(`\nTour le plus lent : ${worstTurn.toFixed(0)} ms`);
console.log(`Taille du plateau : ${SIZE}×${SIZE}`);
