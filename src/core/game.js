/**
 * Déroulement d'une partie à deux : sac, chevalets, tours, fin de partie.
 *
 * L'état est volontairement sérialisable en JSON pour être conservé dans le
 * stockage local du navigateur et repris après fermeture de l'onglet.
 */
import { DISTRIBUTION, RACK_SIZE, VALUES, BLANK, SIZE, difficultyByLevel } from './constants.js';
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
      // L'adversaire porte le nom de sa difficulté. « Centurion » désignait à
      // la fois le jeu, le niveau le plus fort et tout adversaire calculé :
      // on lisait « Centurion joue » en affrontant un Novice.
      {
        name: options.computerName ?? difficultyByLevel(this.level).name,
        rack: [],
        score: 0,
        isAI: true,
      },
    ];
    this.current = options.firstPlayer ?? HUMAN;
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

  /** Retire des tuiles du chevalet courant ; renvoie false si absents. */
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
      if (at < 0) return { ok: false, reason: 'Ces tuiles ne sont pas sur votre chevalet.' };
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

  /** Échange des tuiles contre de nouveaux ; le tour est perdu. */
  exchange(letters) {
    if (this.finished) return { ok: false, reason: 'La partie est terminée.' };
    if (this.bag.length < RACK_SIZE) {
      return { ok: false, reason: 'Il reste moins de sept tuiles dans le sac.' };
    }
    const player = this.currentPlayer;
    if (!this.takeFromRack(player, letters)) {
      return { ok: false, reason: 'Ces tuiles ne sont pas sur votre chevalet.' };
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
          ? `Vous avez posé toutes vos tuiles (+${bonus}).`
          : `${this.players[wentOut].name} a posé toutes ses tuiles (+${bonus}).`;
    } else {
      for (const player of this.players) player.score -= rackValue(player.rack);
      this.endReason = 'Quatre tours blancs consécutifs : la partie s’arrête.';
    }

    const [a, b] = this.players;
    this.winner = a.score === b.score ? null : a.score > b.score ? HUMAN : COMPUTER;
  }

  /* ---------------------------------------------------------------- */
  /* Vues distantes                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * État transmis à un joueur distant, exprimé de SON point de vue : il s'y
   * voit toujours en position 0. L'interface n'a donc jamais à savoir quel
   * siège elle occupe, et le chevalet de l'adversaire n'est jamais transmis.
   *
   * @param {number} viewer siège du destinataire dans cette partie
   */
  snapshot(viewer) {
    const other = viewer === HUMAN ? COMPUTER : HUMAN;
    return {
      letters: [...this.board.letters],
      blanks: [...this.board.blanks],
      rack: [...this.players[viewer].rack],
      opponentTiles: this.players[other].rack.length,
      names: [this.players[viewer].name, this.players[other].name],
      scores: [this.players[viewer].score, this.players[other].score],
      current: this.current === viewer ? HUMAN : COMPUTER,
      bagCount: this.bag.length,
      history: this.history.map((entry) => ({
        ...entry,
        player: entry.player === viewer ? HUMAN : COMPUTER,
      })),
      scorelessTurns: this.scorelessTurns,
      finished: this.finished,
      winner: this.winner === null ? null : this.winner === viewer ? HUMAN : COMPUTER,
      endReason: this.endReason,
      lastMoveCells: this.lastMoveCells,
    };
  }

  /**
   * Reconstitue une partie jouable côté invité à partir d'un instantané.
   * Le sac et le chevalet adverse ne sont représentés que par leur taille :
   * l'invité n'a aucune information cachée, et seul l'hôte arbitre.
   */
  static fromSnapshot(snap) {
    const game = Object.create(Game.prototype);
    game.board = {
      letters: Int8Array.from(snap.letters),
      blanks: Uint8Array.from(snap.blanks),
    };
    game.bag = new Array(snap.bagCount).fill(0);
    game.players = [
      { name: snap.names[0], rack: [...snap.rack], score: snap.scores[0], isAI: false },
      { name: snap.names[1], rack: new Array(snap.opponentTiles).fill(0), score: snap.scores[1], isAI: false },
    ];
    game.current = snap.current;
    game.history = snap.history;
    game.scorelessTurns = snap.scorelessTurns;
    game.finished = snap.finished;
    game.winner = snap.winner;
    game.endReason = snap.endReason;
    game.lastMoveCells = snap.lastMoveCells ?? [];
    game.level = 0;
    return game;
  }

  /* ---------------------------------------------------------------- */

  toJSON() {
    return {
      version: 2,
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
    if (!data || data.version !== 2) return null;
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
