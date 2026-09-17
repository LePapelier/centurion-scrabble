/**
 * Déroulement d'une partie à deux : sac, chevalets, tours, fin de partie.
 *
 * L'état est volontairement sérialisable en JSON pour être conservé dans le
 * stockage local du navigateur et repris après fermeture de l'onglet.
 */
import { DISTRIBUTION, RACK_SIZE, VALUES, BLANK, SIZE } from './constants.js';
import { createBoard, applyPlacements, validateMove } from './board.js';

export const HUMAN = 0;
export const COMPUTER = 1;

/** Nombre de tours blancs consécutifs qui mettent fin à la partie. */
const SCORELESS_LIMIT = 4;

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function freshBag() {
  const bag = [];
  DISTRIBUTION.forEach((count, letter) => {
    for (let n = 0; n < count; n++) bag.push(letter);
  });
  return shuffle(bag);
}

export function rackValue(rack) {
  return rack.reduce((sum, letter) => sum + VALUES[letter], 0);
}

export class Game {
  constructor(options = {}) {
    this.level = options.level ?? 3;
    this.board = createBoard();
    this.bag = freshBag();
    this.players = [
      { name: options.humanName ?? 'Vous', rack: [], score: 0, isAI: false },
      { name: options.computerName ?? 'Centurion', rack: [], score: 0, isAI: true },
    ];
    this.current = HUMAN;
    this.history = [];
    this.scorelessTurns = 0;
    this.finished = false;
    this.winner = null;
    this.lastMoveCells = [];

    this.players.forEach((player) => this.refill(player));
  }

  /* ---------------------------------------------------------------- */

  get bagCount() {
    return this.bag.length;
  }

  get currentPlayer() {
    return this.players[this.current];
  }

  refill(player) {
    while (player.rack.length < RACK_SIZE && this.bag.length > 0) {
      player.rack.push(this.bag.pop());
    }
  }

  /** Retire des jetons du chevalet courant ; renvoie false si absents. */
  takeFromRack(player, letters) {
    const rack = [...player.rack];
    for (const letter of letters) {
      const at = rack.indexOf(letter);
      if (at < 0) return false;
      rack.splice(at, 1);
    }
    player.rack = rack;
    return true;
  }

  /* ---------------------------------------------------------------- */

  /**
   * Joue une pose pour le joueur courant.
   * @returns {{ok: true, score: number, words: object[], bingo: boolean}
   *          |{ok: false, reason: string}}
   */
  play(placements, dawg) {
    if (this.finished) return { ok: false, reason: 'La partie est terminée.' };

    const player = this.currentPlayer;
    const needed = placements.map((p) => (p.blank ? BLANK : p.letter));
    const probe = [...player.rack];
    for (const letter of needed) {
      const at = probe.indexOf(letter);
      if (at < 0) return { ok: false, reason: 'Ces jetons ne sont pas sur votre chevalet.' };
      probe.splice(at, 1);
    }

    const verdict = validateMove(this.board, placements, dawg);
    if (!verdict.ok) return verdict;

    this.takeFromRack(player, needed);
    applyPlacements(this.board, placements);
    player.score += verdict.score;
    this.lastMoveCells = placements.map((p) => p.row * SIZE + p.col);

    this.history.push({
      player: this.current,
      type: 'play',
      words: verdict.words.map((w) => w.word),
      score: verdict.score,
      bingo: verdict.bingo,
      tiles: placements.length,
    });

    this.scorelessTurns = 0;
    const wentOut = player.rack.length === 0 && this.bag.length === 0;
    this.refill(player);

    if (wentOut) this.finish(this.current);
    else this.nextTurn();

    return { ok: true, score: verdict.score, words: verdict.words, bingo: verdict.bingo };
  }

  /** Échange des jetons contre de nouveaux ; le tour est perdu. */
  exchange(letters) {
    if (this.finished) return { ok: false, reason: 'La partie est terminée.' };
    if (this.bag.length < RACK_SIZE) {
      return { ok: false, reason: 'Il reste moins de sept jetons dans le sac.' };
    }
    const player = this.currentPlayer;
    if (!this.takeFromRack(player, letters)) {
      return { ok: false, reason: 'Ces jetons ne sont pas sur votre chevalet.' };
    }

    this.refill(player);
    this.bag.push(...letters);
    shuffle(this.bag);

    this.history.push({ player: this.current, type: 'exchange', count: letters.length, score: 0 });
    this.scorelessTurns++;
    this.afterScorelessTurn();
    return { ok: true };
  }

  pass() {
    if (this.finished) return { ok: false, reason: 'La partie est terminée.' };
    this.history.push({ player: this.current, type: 'pass', score: 0 });
    this.scorelessTurns++;
    this.afterScorelessTurn();
    return { ok: true };
  }

  afterScorelessTurn() {
    if (this.scorelessTurns >= SCORELESS_LIMIT) this.finish(null);
    else this.nextTurn();
  }

  nextTurn() {
    this.current = this.current === HUMAN ? COMPUTER : HUMAN;
  }

  /**
   * Clôture la partie et applique les points de reliquat.
   * @param {number|null} wentOut joueur ayant vidé son chevalet, s'il y en a un
   */
  finish(wentOut) {
    this.finished = true;

    if (wentOut !== null) {
      const other = wentOut === HUMAN ? COMPUTER : HUMAN;
      const bonus = rackValue(this.players[other].rack);
      this.players[wentOut].score += bonus;
      this.players[other].score -= bonus;
      this.endReason =
        wentOut === HUMAN
          ? `Vous avez posé tous vos jetons (+${bonus}).`
          : `${this.players[wentOut].name} a posé tous ses jetons (+${bonus}).`;
    } else {
      for (const player of this.players) player.score -= rackValue(player.rack);
      this.endReason = 'Quatre tours blancs consécutifs : la partie s’arrête.';
    }

    const [a, b] = this.players;
    this.winner = a.score === b.score ? null : a.score > b.score ? HUMAN : COMPUTER;
  }

  /* ---------------------------------------------------------------- */

  toJSON() {
    return {
      version: 1,
      level: this.level,
      letters: [...this.board.letters],
      blanks: [...this.board.blanks],
      bag: this.bag,
      players: this.players.map((p) => ({ ...p, rack: [...p.rack] })),
      current: this.current,
      history: this.history,
      scorelessTurns: this.scorelessTurns,
      finished: this.finished,
      winner: this.winner,
      endReason: this.endReason,
      lastMoveCells: this.lastMoveCells,
    };
  }

  static fromJSON(data) {
    if (!data || data.version !== 1) return null;
    const game = Object.create(Game.prototype);
    game.level = data.level;
    game.board = { letters: Int8Array.from(data.letters), blanks: Uint8Array.from(data.blanks) };
    game.bag = data.bag;
    game.players = data.players;
    game.current = data.current;
    game.history = data.history;
    game.scorelessTurns = data.scorelessTurns;
    game.finished = data.finished;
    game.winner = data.winner;
    game.endReason = data.endReason;
    game.lastMoveCells = data.lastMoveCells ?? [];
    return game;
  }
}
