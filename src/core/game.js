/**
 * Déroulement d'une partie : sac, chevalets, tours, fin de partie.
 *
 * De deux à quatre joueurs. Les sièges sont numérotés dans l'ordre du tour,
 * et le siège 0 est toujours celui qui regarde : en solo c'est le joueur
 * humain, en ligne c'est le destinataire de l'instantané. Tout le rendu peut
 * donc se contenter de savoir qu'il est le joueur 0, sans jamais demander
 * quelle place il occupe réellement dans la partie.
 *
 * L'état est volontairement sérialisable en JSON pour être conservé dans le
 * stockage local du navigateur et repris après fermeture de l'onglet.
 */
import { DISTRIBUTION, RACK_SIZE, VALUES, BLANK, SIZE, difficultyByLevel } from './constants.js';
import { createBoard, applyPlacements, validateMove } from './board.js';

/** Le siège de celui qui regarde. Toujours 0, par construction. */
export const HUMAN = 0;
/** En solo, l'adversaire calculé occupe le siège suivant. */
export const COMPUTER = 1;

/** Bornes du nombre de joueurs autour de la table. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/**
 * Tours blancs consécutifs qui mettent fin à la partie : deux par joueur.
 * À deux cela redonne les quatre tours d'avant ; à quatre, chacun a encore
 * eu deux occasions de débloquer la situation avant qu'on arrête les frais.
 */
const SCORELESS_PER_PLAYER = 2;

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

/** Écriture des seuls nombres que le texte de fin ait à énoncer. */
const NOMBRES = { 4: 'Quatre', 6: 'Six', 8: 'Huit' };

/**
 * Phrase expliquant la fin de partie, rédigée du point de vue du siège 0.
 *
 * Elle est reconstruite chez chaque joueur plutôt que transmise toute faite :
 * rédigée une fois pour toutes par l'hôte, elle dirait « Vous avez posé
 * toutes vos tuiles » et chaque invité la lirait comme parlant de lui.
 */
function endingText(players, ending) {
  if (!ending) return '';
  if (ending.wentOut === null) {
    const turns = ending.turns ?? SCORELESS_PER_PLAYER * players.length;
    return `${NOMBRES[turns] ?? turns} tours blancs consécutifs : la partie s’arrête.`;
  }
  const { wentOut, bonus } = ending;
  return wentOut === HUMAN
    ? `Vous avez posé toutes vos tuiles (+${bonus}).`
    : `${players[wentOut].name} a posé toutes ses tuiles (+${bonus}).`;
}

/** Siège du vainqueur, ou null si plusieurs joueurs terminent à égalité. */
function leader(players) {
  const best = Math.max(...players.map((p) => p.score));
  const tied = players.filter((p) => p.score === best);
  return tied.length === 1 ? players.indexOf(tied[0]) : null;
}

export class Game {
  /**
   * @param {object} options
   * @param {string[]} [options.names] noms des joueurs, dans l'ordre du tour.
   *   Fournis, la partie est entièrement humaine (deux à quatre joueurs) ;
   *   absents, on ouvre une partie solo contre l'adversaire calculé.
   */
  constructor(options = {}) {
    this.level = options.level ?? 3;
    this.board = createBoard();
    this.bag = freshBag();

    if (options.names) {
      const names = options.names.slice(0, MAX_PLAYERS);
      this.players = names.map((name) => ({ name, rack: [], score: 0, isAI: false }));
    } else {
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
    }

    this.current = options.firstPlayer ?? HUMAN;
    this.history = [];
    this.scorelessTurns = 0;
    this.finished = false;
    this.winner = null;
    this.ending = null;
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

  get playerCount() {
    return this.players.length;
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

  /**
   * Échange des tuiles contre de nouvelles ; le tour est perdu.
   *
   * La règle officielle exige sept tuiles au fond du sac. Ici il en suffit
   * d'une : sur un chevalet bloqué en fin de partie, pouvoir troquer sa
   * dernière consonne vaut mieux que d'être condamné à passer. Le nombre de
   * tuiles échangées ne peut pas dépasser ce que le sac contient — sinon on
   * en rendrait plus qu'on n'en pioche et le chevalet fondrait.
   */
  exchange(letters) {
    if (this.finished) return { ok: false, reason: 'La partie est terminée.' };
    if (this.bag.length === 0) {
      return { ok: false, reason: 'Le sac est vide.' };
    }
    if (letters.length > this.bag.length) {
      const n = this.bag.length;
      return {
        ok: false,
        reason: `Le sac ne contient que ${n} tuile${n > 1 ? 's' : ''}.`,
      };
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

  /** Seuil de tours blancs, proportionnel au nombre de joueurs. */
  get scorelessLimit() {
    return SCORELESS_PER_PLAYER * this.players.length;
  }

  afterScorelessTurn() {
    if (this.scorelessTurns >= this.scorelessLimit) this.finish(null);
    else this.nextTurn();
  }

  nextTurn() {
    this.current = (this.current + 1) % this.players.length;
  }

  /**
   * Clôture la partie et applique les points de reliquat.
   * @param {number|null} wentOut joueur ayant vidé son chevalet, s'il y en a un
   */
  finish(wentOut) {
    this.finished = true;

    if (wentOut !== null) {
      // Celui qui sort encaisse le reliquat de tous les autres, et chacun
      // perd le sien. À plus de deux, la prime peut donc peser lourd.
      let bonus = 0;
      this.players.forEach((player, seat) => {
        if (seat === wentOut) return;
        const left = rackValue(player.rack);
        player.score -= left;
        bonus += left;
      });
      this.players[wentOut].score += bonus;
      this.ending = { wentOut, bonus };
    } else {
      for (const player of this.players) player.score -= rackValue(player.rack);
      this.ending = { wentOut: null, turns: this.scorelessLimit };
    }

    this.endReason = endingText(this.players, this.ending);
    this.winner = leader(this.players);
  }

  /* ---------------------------------------------------------------- */
  /* Vues distantes                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * État transmis à un joueur distant, exprimé de SON point de vue : il s'y
   * voit toujours en position 0, et les autres le suivent dans l'ordre du
   * tour. L'interface n'a donc jamais à savoir quel siège elle occupe, et
   * aucun chevalet adverse n'est transmis.
   *
   * La table est tournée, pas retournée : à quatre, celui qui joue après moi
   * reste en position 1 pour moi comme pour lui, ce qui garde lisible « à qui
   * le tour » sans transmettre de numéro de siège absolu.
   *
   * @param {number} viewer siège du destinataire dans cette partie
   */
  snapshot(viewer) {
    const seats = this.seatsFrom(viewer);
    const local = (seat) => (seat - viewer + this.players.length) % this.players.length;
    return {
      letters: [...this.board.letters],
      blanks: [...this.board.blanks],
      rack: [...this.players[viewer].rack],
      tiles: seats.map((seat) => this.players[seat].rack.length),
      names: seats.map((seat) => this.players[seat].name),
      scores: seats.map((seat) => this.players[seat].score),
      current: local(this.current),
      bagCount: this.bag.length,
      history: this.history.map((entry) => ({ ...entry, player: local(entry.player) })),
      scorelessTurns: this.scorelessTurns,
      finished: this.finished,
      winner: this.winner === null ? null : local(this.winner),
      ending: this.ending ? { ...this.ending, wentOut: this.ending.wentOut === null ? null : local(this.ending.wentOut) } : null,
      lastMoveCells: this.lastMoveCells,
    };
  }

  /** Sièges dans l'ordre du tour, en partant de celui indiqué. */
  seatsFrom(seat) {
    return this.players.map((_, i) => (seat + i) % this.players.length);
  }

  /**
   * Reconstitue une partie jouable côté invité à partir d'un instantané.
   * Le sac et les chevalets adverses ne sont représentés que par leur taille :
   * l'invité n'a aucune information cachée, et seul l'hôte arbitre.
   */
  static fromSnapshot(snap) {
    const game = Object.create(Game.prototype);
    game.board = {
      letters: Int8Array.from(snap.letters),
      blanks: Uint8Array.from(snap.blanks),
    };
    game.bag = new Array(snap.bagCount).fill(0);
    game.players = snap.names.map((name, seat) => ({
      name,
      rack: seat === HUMAN ? [...snap.rack] : new Array(snap.tiles[seat]).fill(0),
      score: snap.scores[seat],
      isAI: false,
    }));
    game.current = snap.current;
    game.history = snap.history;
    game.scorelessTurns = snap.scorelessTurns;
    game.finished = snap.finished;
    game.winner = snap.winner;
    game.ending = snap.ending ?? null;
    // La phrase de fin est rédigée ici, avec les noms tels que ce joueur les
    // voit : transmise toute faite, elle tutoierait le mauvais joueur.
    game.endReason = endingText(game.players, game.ending);
    game.lastMoveCells = snap.lastMoveCells ?? [];
    game.level = 0;
    return game;
  }

  /* ---------------------------------------------------------------- */

  toJSON() {
    return {
      version: 2,
      ending: this.ending ?? null,
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
    // Les parties enregistrées avant l'arrivée des tables à plus de deux ne
    // portent que la phrase toute faite : on la garde telle quelle.
    game.ending = data.ending ?? null;
    game.endReason = data.endReason;
    game.lastMoveCells = data.lastMoveCells ?? [];
    return game;
  }
}
