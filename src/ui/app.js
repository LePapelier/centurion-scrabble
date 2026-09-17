/**
 * Contrôleur de l'interface : rendu du plateau, saisie tactile et clavier,
 * enchaînement des tours avec l'adversaire calculé dans un worker.
 */
import {
  SIZE,
  CELLS,
  CENTER,
  BLANK,
  RACK_SIZE,
  PREMIUMS,
  VALUES,
  DIFFICULTIES,
  difficultyByLevel,
  letterChar,
  coordName,
  DOUBLE_LETTER,
  TRIPLE_LETTER,
  DOUBLE_WORD,
  TRIPLE_WORD,
} from '../core/constants.js';
import { Game, HUMAN, COMPUTER } from '../core/game.js';
import { validateMove } from '../core/board.js';
import {
  PeerSession,
  inviteLink,
  codeFromLocation,
  clearLocationCode,
  normalizeCode,
} from '../net/session.js';

const PREMIUM_CLASS = {
  [DOUBLE_LETTER]: 'dl',
  [TRIPLE_LETTER]: 'tl',
  [DOUBLE_WORD]: 'dw',
  [TRIPLE_WORD]: 'tw',
};

const PREMIUM_LABEL = {
  [DOUBLE_LETTER]: 'LD',
  [TRIPLE_LETTER]: 'LT',
  [DOUBLE_WORD]: 'MD',
  [TRIPLE_WORD]: 'MT',
};

const STORAGE_KEY = 'centurion-scrabble/partie';
const LEVEL_KEY = 'centurion-scrabble/niveau';
const NAME_KEY = 'centurion-scrabble/nom';
const MIN_THINKING_MS = 450;

/** Décalage entre deux jetons lors de la révélation d'un coup. */
const REVEAL_STEP_MS = 60;
const SCORE_COUNT_MS = 520;

/**
 * Insigne de chaque niveau : un à trois galons, l'étoile de l'expert, puis la
 * couronne du Centurion. L'échelle se lit d'un coup d'œil, et chaque forme
 * reste distincte à la taille d'une pastille.
 */
const LEVEL_ICONS = {
  1: '<path d="M5 16l7-6 7 6"/>',
  2: '<path d="M5 13l7-6 7 6"/><path d="M5 19l7-6 7 6"/>',
  3: '<path d="M5 10l7-6 7 6"/><path d="M5 15l7-6 7 6"/><path d="M5 20l7-6 7 6"/>',
  4: '<path d="m12 3 2.5 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.3 6.8 19.2l1.1-5.9L3.6 9.2l5.9-.8z"/>',
  5: '<path d="M4 19h16"/><path d="m4 19-1.2-11L8 12l4-7.5 4 7.5 5.2-4L20 19z"/>',
};

const levelIcon = (level) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${LEVEL_ICONS[level] ?? LEVEL_ICONS[3]}</svg>`;

const $ = (id) => document.getElementById(id);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

export class App {
  /**
   * @param {{dawg: import('../core/dawg.js').Dawg, worker: Worker, meta: object}} deps
   */
  constructor({ dawg, worker, meta }) {
    this.dawg = dawg;
    this.worker = worker;
    this.meta = meta;

    /** @type {Map<number, {letter:number, blank:boolean, rackIndex:number}>} */
    this.pending = new Map();
    this.selected = null;
    this.cursor = null;
    this.exchangeMode = false;
    this.marked = new Set();
    this.busy = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.toastTimer = null;

    /** Cases à animer au prochain rendu, dans l'ordre de la pose. */
    this.revealCells = [];
    this.revealKind = 'settle';
    /** Index du chevalet déjà affichés, pour n'animer que les nouveaux. */
    this.rackShown = new Set();
    this.forceRackPop = false;
    this.shownScores = [0, 0];
    this.scoreFrames = [0, 0];
    this.haloScore = null;
    this.dragEndedAt = 0;
    this.dropCell = null;

    /** 'solo' face à l'IA, 'host' ou 'guest' en partie à deux. */
    this.mode = 'solo';
    this.session = null;
    this.myName = localStorage.getItem(NAME_KEY) || 'Joueur';
    this.opponentName = 'Adversaire';

    this.level = Number(localStorage.getItem(LEVEL_KEY)) || 3;
    this.game = this.restore() ?? new Game({ level: this.level });
    this.level = this.game.level;

    this.worker.addEventListener('message', (event) => this.onWorkerMessage(event.data));
  }

  /* ---------------------------------------------------------------- */
  /* Persistance                                                       */
  /* ---------------------------------------------------------------- */

  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const game = Game.fromJSON(JSON.parse(raw));
      return game && !game.finished ? game : null;
    } catch {
      return null;
    }
  }

  save() {
    // Une partie en ligne appartient à l'hôte : on ne l'écrase pas sur la
    // sauvegarde solo, qui doit rester reprenable.
    if (this.mode !== 'solo') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.game.toJSON()));
      localStorage.setItem(LEVEL_KEY, String(this.level));
    } catch {
      /* stockage indisponible : la partie reste jouable, sans reprise */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Montage                                                           */
  /* ---------------------------------------------------------------- */

  mount() {
    this.buildBoard();
    this.buildLetterGrid();
    this.buildLevels();
    this.bindActions();
    this.bindKeyboard();

    // Une partie reprise affiche ses scores tels quels, sans les recompter.
    this.shownScores = this.game.players.map((p) => p.score);
    window.addEventListener('resize', () => this.updateHalo());

    this.bindNetwork();

    $('dict-note').textContent =
      `Dictionnaire : ${this.meta.words.toLocaleString('fr-FR')} mots, conforme à l’orthographe du Scrabble ` +
      `(accents ignorés, 2 à 15 lettres). Source : ${this.meta.source}.`;

    this.render();
    if (this.game.current === COMPUTER && !this.game.finished) this.runComputerTurn();
  }

  buildBoard() {
    const board = $('board');
    this.boardEl = board;
    const fragment = document.createDocumentFragment();
    this.cells = [];

    for (let i = 0; i < CELLS; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = String(i);
      cell.setAttribute('role', 'gridcell');

      const premium = PREMIUMS[i];
      if (i === CENTER) cell.classList.add('center');
      else if (PREMIUM_CLASS[premium]) cell.classList.add(PREMIUM_CLASS[premium]);

      fragment.append(cell);
      this.cells.push(cell);
    }

    board.append(fragment);
    board.addEventListener('click', (event) => {
      // Un glissement qui vient de se terminer produit aussi un clic : il ne
      // doit pas être pris pour un appui sur la case d'arrivée.
      if (performance.now() - this.dragEndedAt < 250) return;
      const cell = event.target.closest('.cell');
      if (cell) this.onCellTap(Number(cell.dataset.index));
    });
  }

  buildLetterGrid() {
    const grid = $('letter-grid');
    for (let letter = 0; letter < 26; letter++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = letterChar(letter);
      button.addEventListener('click', () => this.resolveBlank?.(letter));
      grid.append(button);
    }
  }

  buildLevels() {
    const container = $('levels');
    for (const difficulty of DIFFICULTIES) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'level-option';
      option.dataset.level = String(difficulty.level);
      option.innerHTML =
        `<span class="level-badge">${levelIcon(difficulty.level)}</span>` +
        `<span class="level-text"><span class="level-name">${difficulty.name}` +
        `<span class="level-rank">niveau ${difficulty.level}</span></span>` +
        `<span class="level-blurb">${difficulty.blurb}</span></span>`;
      option.addEventListener('click', () => {
        this.level = difficulty.level;
        this.game.level = difficulty.level;
        this.save();
        this.renderLevels();
        this.renderScores();
        $('rules-dialog').close();
        this.toast(`Niveau ${difficulty.level} — ${difficulty.name}`);
      });
      container.append(option);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendu                                                             */
  /* ---------------------------------------------------------------- */

  render() {
    this.renderBoard();
    this.renderRack();
    this.renderScores();
    this.renderLog();
    this.renderControls();
    this.renderLevels();
  }

  renderBoard() {
    const { letters, blanks } = this.game.board;
    const highlight = new Set(this.game.lastMoveCells);

    for (let i = 0; i < CELLS; i++) {
      const cell = this.cells[i];
      const pending = this.pending.get(i);
      const letter = letters[i];

      cell.classList.toggle('highlight', highlight.has(i) && letter >= 0);
      cell.classList.toggle('cursor', this.cursor?.index === i && letter < 0 && !pending);

      const wanted = pending
        ? `p${pending.letter}${pending.blank ? 'b' : ''}`
        : letter >= 0
          ? `f${letter}${blanks[i] ? 'b' : ''}`
          : 'e';

      if (cell.dataset.state === wanted) continue;
      cell.dataset.state = wanted;
      cell.textContent = '';

      if (pending) {
        const tile = this.tileElement(pending.letter, pending.blank, 'tile pending fresh');
        this.attachTileDrag(tile, { from: 'board', index: i });
        cell.append(tile);
      } else if (letter >= 0) {
        const tile = this.tileElement(letter, Boolean(blanks[i]), 'tile');
        const rank = this.revealCells.indexOf(i);
        if (rank >= 0 && !reducedMotion.matches) {
          tile.classList.add(this.revealKind);
          tile.style.animationDelay = `${rank * REVEAL_STEP_MS}ms`;
        }
        cell.append(tile);
      } else if (i === CENTER) {
        cell.textContent = '★';
      } else if (PREMIUM_LABEL[PREMIUMS[i]]) {
        cell.textContent = PREMIUM_LABEL[PREMIUMS[i]];
      }
    }

    this.revealCells = [];
  }

  /**
   * Cerne le mot en cours s'il est jouable, et renvoie le verdict complet.
   * @returns {object|null}
   */
  updateHalo() {
    const halo = $('halo');
    const badge = $('halo-score');

    const active = this.pending.size > 0 && this.game.current === HUMAN && !this.game.finished;
    const verdict = active ? validateMove(this.game.board, this.placements(), this.dawg) : null;

    if (!verdict?.ok) {
      halo.hidden = true;
      this.haloScore = null;
      return verdict;
    }

    // L'emprise suit le mot le plus long ; le score affiché est celui du coup
    // entier, mots croisés et prime de scrabble compris.
    const main = verdict.words.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
    const board = this.boardEl.getBoundingClientRect();
    const first = this.cells[main.cells[0]].getBoundingClientRect();
    const last = this.cells[main.cells[main.cells.length - 1]].getBoundingClientRect();
    const pad = Math.max(2, board.width * 0.006);

    const wasHidden = halo.hidden;
    // Les dimensions sont posées avant l'affichage : une apparition ne doit
    // pas déclencher la transition de déplacement.
    halo.style.left = `${first.left - board.left - pad}px`;
    halo.style.top = `${first.top - board.top - pad}px`;
    halo.style.width = `${last.right - first.left + pad * 2}px`;
    halo.style.height = `${last.bottom - first.top + pad * 2}px`;
    halo.hidden = false;

    if (verdict.score !== this.haloScore) {
      badge.textContent = String(verdict.score);
      if (!wasHidden) this.replay(badge, 'bump');
      this.haloScore = verdict.score;
    }
    return verdict;
  }

  /** Rejoue une animation déjà posée sur un élément. */
  replay(element, className) {
    if (reducedMotion.matches) return;
    element.classList.remove(className);
    void element.offsetWidth; // force le recalcul pour relancer l'animation
    element.classList.add(className);
  }

  tileElement(letter, blank, className) {
    const tile = document.createElement('div');
    tile.className = blank ? `${className} blank` : className;
    tile.append(document.createTextNode(letterChar(letter)));
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = String(blank ? 0 : VALUES[letter]);
    tile.append(value);
    return tile;
  }

  renderRack() {
    const rack = $('rack');
    const tiles = this.game.players[HUMAN].rack;
    const used = new Set([...this.pending.values()].map((p) => p.rackIndex));
    const shown = new Set();
    let entering = 0;

    rack.textContent = '';
    for (let i = 0; i < 7; i++) {
      const slot = document.createElement('div');
      slot.className = 'rack-slot';

      if (i < tiles.length && !used.has(i)) {
        const letter = tiles[i];
        const tile = document.createElement('div');
        tile.className = 'rack-tile';
        tile.dataset.rackIndex = String(i);
        if (this.selected === i) tile.classList.add('selected');
        if (this.marked.has(i)) tile.classList.add('marked');
        tile.append(document.createTextNode(letterChar(letter)));

        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = String(VALUES[letter]);
        tile.append(value);

        shown.add(i);
        if ((this.forceRackPop || !this.rackShown.has(i)) && !reducedMotion.matches) {
          tile.classList.add('pop');
          tile.style.animationDelay = `${entering++ * 45}ms`;
        }

        this.attachTileDrag(tile, { from: 'rack', rackIndex: i });
        slot.append(tile);
      }
      rack.append(slot);
    }

    this.rackShown = shown;
    this.forceRackPop = false;
  }

  renderScores() {
    const [human, ai] = this.game.players;
    this.updateScore($('score-human-value'), $('score-human'), 0, human.score);
    this.updateScore($('score-ai-value'), $('score-ai'), 1, ai.score);
    const label = $('ai-name');
    if (this.mode === 'solo') {
      const difficulty = difficultyByLevel(this.level);
      // Contenu entièrement issu de nos constantes : pas de texte distant ici.
      label.innerHTML = `${levelIcon(difficulty.level)}<span>${difficulty.name}</span>`;
      label.disabled = false;
      label.title = `Niveau ${difficulty.level} — ${difficulty.blurb}`;
      label.setAttribute('aria-label', `Niveau ${difficulty.level}, ${difficulty.name}. Changer de niveau.`);
    } else {
      // Nom venu du réseau : jamais interprété comme du balisage.
      label.textContent = this.opponentName;
      label.disabled = true;
      label.removeAttribute('title');
      label.removeAttribute('aria-label');
    }
    $('bag-count').textContent = String(this.game.bagCount);

    const active = this.game.finished ? -1 : this.game.current;
    $('score-human').classList.toggle('active', active === HUMAN);
    $('score-ai').classList.toggle('active', active === COMPUTER);
  }

  /** Fait défiler un score jusqu'à sa nouvelle valeur. */
  updateScore(valueEl, cardEl, slot, target) {
    const from = this.shownScores[slot];
    if (from === target) {
      valueEl.textContent = String(target);
      return;
    }
    this.shownScores[slot] = target;

    if (reducedMotion.matches) {
      valueEl.textContent = String(target);
      return;
    }

    if (target > from) this.floatGain(cardEl, target - from);
    this.replay(valueEl, 'bump');

    cancelAnimationFrame(this.scoreFrames[slot]);
    const started = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - started) / SCORE_COUNT_MS);
      const eased = 1 - (1 - t) ** 3;
      valueEl.textContent = String(Math.round(from + (target - from) * eased));
      if (t < 1) this.scoreFrames[slot] = requestAnimationFrame(step);
    };
    this.scoreFrames[slot] = requestAnimationFrame(step);
  }

  /** Petit « +N » qui s'élève au-dessus du score. */
  floatGain(cardEl, amount) {
    const gain = document.createElement('span');
    gain.className = 'score-gain';
    gain.textContent = `+${amount}`;
    cardEl.append(gain);
    setTimeout(() => gain.remove(), 1300);
  }

  renderLog() {
    const log = $('log');
    log.textContent = '';

    for (let i = this.game.history.length - 1; i >= 0; i--) {
      const entry = this.game.history[i];
      const item = document.createElement('li');

      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = this.game.players[entry.player].name;

      const what = document.createElement('span');
      what.className = 'what';
      if (entry.type === 'play') {
        what.textContent = entry.words.join(' · ') + (entry.bingo ? '  ⚡' : '');
      } else if (entry.type === 'exchange') {
        what.className = 'what muted';
        what.textContent = `échange ${entry.count} jeton${entry.count > 1 ? 's' : ''}`;
      } else {
        what.className = 'what muted';
        what.textContent = 'passe';
      }

      const points = document.createElement('span');
      points.className = entry.score > 0 ? 'pts' : 'pts zero';
      points.textContent = entry.score > 0 ? `+${entry.score}` : '—';

      item.append(who, what, points);
      log.append(item);
    }

    if (this.game.history.length === 0) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="what muted">Aucun coup joué.</span>';
      log.append(empty);
    }
  }

  renderLevels() {
    for (const option of $('levels').children) {
      option.classList.toggle('selected', Number(option.dataset.level) === this.level);
    }
  }

  renderControls() {
    const linked = this.mode === 'solo' || Boolean(this.session?.connected);
    const myTurn = this.game.current === HUMAN && !this.game.finished && !this.busy && linked;
    const hasPending = this.pending.size > 0;

    $('btn-play').disabled = !myTurn || !hasPending;
    $('btn-recall').disabled = !hasPending;
    $('btn-shuffle').disabled = !myTurn;
    $('btn-hint').disabled = !myTurn;
    $('btn-more').disabled = !myTurn;
    $('btn-exchange-wide').disabled = !myTurn || this.game.bagCount < RACK_SIZE;
    $('btn-pass-wide').disabled = !myTurn;
    $('btn-resign-wide').disabled = this.game.finished;

    // Le halo et la pastille de score ne s'allument que sur un coup jouable :
    // le score annoncé est toujours un score réellement encaissable.
    const verdict = this.updateHalo();
    const preview = $('preview');
    if (verdict?.ok) {
      preview.hidden = false;
      preview.textContent = String(verdict.score);
    } else {
      preview.hidden = true;
    }

    this.renderStatus();
    this.renderNetChip();
  }

  renderStatus() {
    const status = $('status');
    status.className = 'status';

    if (this.game.finished) {
      status.classList.add('win');
      status.textContent = this.endSentence();
      return;
    }
    if (this.busy) {
      status.textContent = '';
      return;
    }
    if (this.exchangeMode) {
      status.textContent = `${this.marked.size} jeton${this.marked.size > 1 ? 's' : ''} sélectionné${this.marked.size > 1 ? 's' : ''}.`;
      return;
    }
    if (this.mode !== 'solo' && !this.session?.connected) {
      status.classList.add('warn');
      status.textContent = 'Liaison interrompue avec votre adversaire.';
      return;
    }
    if (this.game.current !== HUMAN) {
      status.textContent =
        this.mode === 'solo' ? 'Au tour de votre adversaire.' : `Au tour de ${this.opponentName}.`;
      return;
    }
    if (this.pending.size > 0) {
      status.textContent = 'Validez votre mot ou reprenez vos jetons.';
      return;
    }
    status.textContent =
      this.game.history.length === 0
        ? 'Posez votre premier mot sur la case centrale.'
        : 'À vous de jouer.';
  }

  endSentence() {
    if (this.game.winner === null) return 'Égalité parfaite.';
    if (this.game.winner === HUMAN) return 'Vous gagnez !';
    return this.mode === 'solo' ? 'Centurion l’emporte.' : `${this.opponentName} l’emporte.`;
  }

  /* ---------------------------------------------------------------- */
  /* Saisie                                                            */
  /* ---------------------------------------------------------------- */

  placements() {
    return [...this.pending.entries()].map(([index, tile]) => ({
      row: Math.floor(index / SIZE),
      col: index % SIZE,
      letter: tile.letter,
      blank: tile.blank,
    }));
  }

  onCellTap(index) {
    if (this.game.finished || this.busy || this.game.current !== HUMAN) return;
    if (this.exchangeMode) return;

    if (this.pending.has(index)) {
      this.pending.delete(index);
      this.cursor = { index, direction: this.cursor?.direction ?? 0 };
      this.refresh();
      return;
    }

    if (this.game.board.letters[index] >= 0) return;

    if (this.selected !== null) {
      this.placeTile(index, this.selected);
      return;
    }

    // Sans jeton sélectionné, la case devient le point de saisie clavier.
    const sameCell = this.cursor?.index === index;
    this.cursor = { index, direction: sameCell ? 1 - this.cursor.direction : 0 };
    this.refresh();
  }

  async placeTile(index, rackIndex) {
    const letter = this.game.players[HUMAN].rack[rackIndex];
    if (letter === undefined) return;

    let placed = letter;
    let blank = false;

    if (letter === BLANK) {
      const chosen = await this.askBlankLetter();
      if (chosen === null) return;
      placed = chosen;
      blank = true;
    }

    this.pending.set(index, { letter: placed, blank, rackIndex });
    this.selected = null;
    this.cursor = { index: this.nextCell(index), direction: this.cursor?.direction ?? 0 };
    this.refresh();
  }

  /** Case suivante libre, dans la direction de saisie courante. */
  nextCell(index) {
    const direction = this.cursor?.direction ?? 0;
    const step = direction === 0 ? 1 : SIZE;
    let next = index + step;
    while (next < CELLS) {
      if (direction === 0 && Math.floor(next / SIZE) !== Math.floor(index / SIZE)) return -1;
      if (this.game.board.letters[next] < 0 && !this.pending.has(next)) return next;
      next += step;
    }
    return -1;
  }

  selectRackTile(rackIndex) {
    if (this.exchangeMode) {
      if (this.marked.has(rackIndex)) this.marked.delete(rackIndex);
      else this.marked.add(rackIndex);
      this.refresh();
      return;
    }
    this.selected = this.selected === rackIndex ? null : rackIndex;
    this.refresh();
  }

  /** Glisser-déposer au doigt comme à la souris. */
  /**
   * Rend un jeton déplaçable à la souris comme au doigt.
   *
   * @param {HTMLElement} element
   * @param {{from: 'rack', rackIndex: number}|{from: 'board', index: number}} origin
   */
  attachTileDrag(element, origin) {
    let ghost = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const onMove = (event) => {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 8) return;

      if (!dragging) {
        dragging = true;
        element.classList.add('dragging');
        const box = element.getBoundingClientRect();
        ghost = element.cloneNode(true);
        ghost.className = 'drag-ghost';
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
        ghost.style.fontSize = getComputedStyle(element).fontSize;
        document.body.append(ghost);
      }
      ghost.style.left = `${event.clientX}px`;
      ghost.style.top = `${event.clientY}px`;
      this.highlightDrop(origin, event.clientX, event.clientY);
    };

    const onUp = (event) => {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.classList.remove('dragging');

      if (!dragging) {
        // Simple appui. Sur le chevalet il vaut sélection ; sur le plateau
        // c'est le gestionnaire de clic du plateau qui s'en charge.
        if (origin.from === 'rack') this.selectRackTile(origin.rackIndex);
        return;
      }

      ghost?.remove();
      ghost = null;
      this.clearDropHighlight();
      // Le clic qui suit un glissement ne doit pas être réinterprété.
      this.dragEndedAt = performance.now();
      this.dropTile(origin, event.clientX, event.clientY);
    };

    element.addEventListener('pointerdown', (event) => {
      if (this.game.finished || this.busy || this.game.current !== HUMAN) return;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* pointeur déjà relâché : le suivi reste correct sans capture */
      }
      element.addEventListener('pointermove', onMove);
      element.addEventListener('pointerup', onUp);
      element.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * Signale la destination survolée : case accueillante, case refusée, ou
   * chevalet lorsqu'on ramène un jeton déjà posé.
   */
  highlightDrop(origin, x, y) {
    const under = document.elementFromPoint(x, y);
    const cell = under?.closest('.cell') ?? null;

    if (cell !== this.dropCell) {
      this.dropCell?.classList.remove('drop-target', 'drop-blocked');
      this.dropCell = cell;
    }

    if (cell) {
      const index = Number(cell.dataset.index);
      // La case de départ d'un jeton déplacé reste une destination valable.
      const free =
        index === origin.index ||
        (this.game.board.letters[index] < 0 && !this.pending.has(index));
      cell.classList.toggle('drop-target', free);
      cell.classList.toggle('drop-blocked', !free);
    }

    const overRack = Boolean(under?.closest('.rack')) && !cell;
    $('rack').classList.toggle('drop-active', overRack);
  }

  clearDropHighlight() {
    this.dropCell?.classList.remove('drop-target', 'drop-blocked');
    this.dropCell = null;
    $('rack').classList.remove('drop-active');
  }

  /** Applique le lâcher d'un jeton à la position du pointeur. */
  dropTile(origin, x, y) {
    if (this.exchangeMode) {
      this.refresh();
      return;
    }

    const under = document.elementFromPoint(x, y);
    const cell = under?.closest('.cell');
    const rack = under?.closest('.rack');

    if (cell) {
      const index = Number(cell.dataset.index);
      const free = this.game.board.letters[index] < 0 && !this.pending.has(index);

      if (origin.from === 'rack') {
        if (free) {
          this.placeTile(index, origin.rackIndex);
          return;
        }
      } else if (index === origin.index) {
        this.refresh(); // reposé sur sa propre case
        return;
      } else if (free) {
        // Déplacement d'un jeton déjà posé, sans repasser par le chevalet.
        const tile = this.pending.get(origin.index);
        this.pending.delete(origin.index);
        this.pending.set(index, tile);
        this.cursor = { index: this.nextCell(index), direction: this.cursor?.direction ?? 0 };
        this.refresh();
        return;
      }
    } else if (rack) {
      if (origin.from === 'board') {
        this.pending.delete(origin.index); // retour au chevalet
        this.refresh();
        return;
      }
      this.reorderRack(origin.rackIndex, this.rackDropIndex(x));
      return;
    }

    this.refresh();
  }

  /**
   * Position d'insertion sur le chevalet, déduite des milieux d'emplacement.
   * Les emplacements vides comptent : leur index correspond toujours à celui
   * du chevalet, même quand des jetons sont posés sur le plateau.
   */
  rackDropIndex(x) {
    const slots = [...$('rack').children];
    for (let i = 0; i < slots.length; i++) {
      const box = slots[i].getBoundingClientRect();
      if (x < box.left + box.width / 2) return i;
    }
    return slots.length;
  }

  /**
   * Déplace un jeton du chevalet à une autre position.
   *
   * Les poses en attente référencent leur jeton par son index de chevalet :
   * ces références sont donc réécrites, faute de quoi valider le coup
   * consommerait les mauvaises lettres.
   */
  reorderRack(from, insertAt) {
    const rack = this.game.players[HUMAN].rack;
    if (from < 0 || from >= rack.length) return;

    let to = Math.max(0, Math.min(insertAt, rack.length));
    // Après extraction, tout ce qui suit recule d'un cran.
    if (from < to) to -= 1;
    if (to === from) {
      this.refresh();
      return;
    }

    const order = rack.map((_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);

    const remap = new Map();
    order.forEach((oldIndex, newIndex) => remap.set(oldIndex, newIndex));

    this.game.players[HUMAN].rack = order.map((i) => rack[i]);
    for (const tile of this.pending.values()) {
      tile.rackIndex = remap.get(tile.rackIndex) ?? tile.rackIndex;
    }
    if (this.selected !== null) this.selected = remap.get(this.selected) ?? null;
    if (this.marked.size > 0) {
      this.marked = new Set([...this.marked].map((i) => remap.get(i) ?? i));
    }

    this.save();
    this.refresh();
  }

  askBlankLetter() {
    const dialog = $('blank-dialog');
    dialog.showModal();
    return new Promise((resolve) => {
      const finish = (value) => {
        this.resolveBlank = null;
        dialog.close();
        resolve(value);
      };
      this.resolveBlank = finish;
      $('blank-cancel').onclick = () => finish(null);
      dialog.onclose = () => this.resolveBlank && finish(null);
    });
  }

  bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (event.target.closest('dialog')) return;
      if (this.game.finished || this.busy || this.game.current !== HUMAN) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitPlay();
        return;
      }
      if (event.key === 'Escape') {
        this.recall();
        return;
      }
      if (event.key === 'Backspace') {
        event.preventDefault();
        const last = [...this.pending.keys()].pop();
        if (last !== undefined) {
          this.pending.delete(last);
          this.cursor = { index: last, direction: this.cursor?.direction ?? 0 };
          this.refresh();
        }
        return;
      }

      if (!/^[a-zA-Zà-ÿ]$/.test(event.key) || !this.cursor || this.cursor.index < 0) return;

      const wanted = event.key
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .charCodeAt(0) - 65;
      if (wanted < 0 || wanted > 25) return;

      const rack = this.game.players[HUMAN].rack;
      const used = new Set([...this.pending.values()].map((p) => p.rackIndex));
      let index = rack.findIndex((l, i) => l === wanted && !used.has(i));
      if (index < 0) index = rack.findIndex((l, i) => l === BLANK && !used.has(i));
      if (index < 0) return;

      event.preventDefault();
      const target = this.cursor.index;
      if (rack[index] === BLANK) {
        this.pending.set(target, { letter: wanted, blank: true, rackIndex: index });
        this.cursor = { index: this.nextCell(target), direction: this.cursor.direction };
        this.refresh();
      } else {
        this.placeTile(target, index);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  bindActions() {
    $('btn-play').onclick = () => this.commitPlay();
    $('btn-recall').onclick = () => this.recall();
    $('btn-shuffle').onclick = () => this.shuffleRack();
    $('btn-hint').onclick = () => this.askHint();

    $('ai-name').onclick = () => {
      if (this.mode === 'solo') $('rules-dialog').showModal();
    };

    // Mêmes actions que le menu « ⋯ », présentées en clair sur grand écran.
    $('btn-exchange-wide').onclick = () => this.startExchange();
    $('btn-pass-wide').onclick = () => this.passTurn();
    $('btn-resign-wide').onclick = () => this.resign();

    $('btn-more').onclick = () => $('more-dialog').showModal();
    $('more-cancel').onclick = () => $('more-dialog').close();
    $('btn-pass').onclick = () => {
      $('more-dialog').close();
      this.passTurn();
    };
    $('btn-exchange').onclick = () => {
      $('more-dialog').close();
      this.startExchange();
    };
    $('btn-resign').onclick = () => {
      $('more-dialog').close();
      this.resign();
    };

    $('btn-exchange-cancel').onclick = () => this.cancelExchange();
    $('btn-exchange-confirm').onclick = () => this.confirmExchange();

    // Le sélecteur de niveau s'ouvre depuis la pastille du bandeau de score :
    // un bouton dédié dans l'en-tête faisait double emploi.
    $('rules-close').onclick = () => $('rules-dialog').close();

    $('btn-new').onclick = () => $('new-dialog').showModal();
    $('new-cancel').onclick = () => $('new-dialog').close();
    $('new-confirm').onclick = () => {
      $('new-dialog').close();
      this.newGame();
    };

    $('end-close').onclick = () => $('end-dialog').close();
    $('end-again').onclick = () => {
      $('end-dialog').close();
      this.newGame();
    };

    const toggle = $('log-toggle');
    toggle.onclick = () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      $('log').hidden = open;
    };
  }

  refresh() {
    this.renderBoard();
    this.renderRack();
    this.renderControls();
  }

  recall() {
    if (this.pending.size === 0) return;
    this.pending.clear();
    this.selected = null;
    this.refresh();
  }

  shuffleRack() {
    this.recall();
    const rack = this.game.players[HUMAN].rack;
    for (let i = rack.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rack[i], rack[j]] = [rack[j], rack[i]];
    }
    this.selected = null;
    this.forceRackPop = true;
    this.refresh();
  }

  commitPlay() {
    if (this.pending.size === 0 || this.busy || this.game.current !== HUMAN) return;

    if (this.mode === 'guest') {
      // L'invité ne fait pas autorité : il vérifie pour lui-même, puis laisse
      // l'hôte arbitrer et lui renvoyer l'état.
      const verdict = validateMove(this.game.board, this.placements(), this.dawg);
      if (!verdict.ok) {
        this.toast(verdict.reason, 'error');
        return;
      }
      this.sendIntent({ t: 'play', placements: this.placements() });
      return;
    }

    const result = this.game.play(this.placements(), this.dawg);
    if (!result.ok) {
      this.toast(result.reason, 'error');
      return;
    }

    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.revealCells = [...this.game.lastMoveCells];
    this.revealKind = 'settle';

    const words = result.words.map((w) => w.word).join(', ');
    this.toast(
      result.bingo ? `Scrabble ! ${words} — ${result.score} points` : `${words} — ${result.score} points`,
      'good',
    );
    if (result.bingo) this.replay(this.boardEl, 'bingo');

    this.save();
    this.render();
    this.broadcast();
    this.afterTurn();
  }

  passTurn() {
    this.recall();
    if (this.mode === 'guest') {
      this.sendIntent({ t: 'pass' });
      return;
    }
    this.game.pass();
    this.save();
    this.render();
    this.broadcast();
    this.afterTurn();
  }

  startExchange() {
    if (this.game.bagCount < 7) {
      this.toast('Le sac contient moins de sept jetons.', 'error');
      return;
    }
    this.recall();
    this.exchangeMode = true;
    this.marked.clear();
    this.selected = null;
    $('exchange-bar').hidden = false;
    $('actions').hidden = true;
    this.refresh();
  }

  cancelExchange() {
    this.exchangeMode = false;
    this.marked.clear();
    $('exchange-bar').hidden = true;
    $('actions').hidden = false;
    this.refresh();
  }

  confirmExchange() {
    if (this.marked.size === 0) {
      this.toast('Choisissez au moins un jeton.', 'error');
      return;
    }
    const rack = this.game.players[HUMAN].rack;
    const tiles = [...this.marked].map((i) => rack[i]);

    if (this.mode === 'guest') {
      this.cancelExchange();
      this.sendIntent({ t: 'exchange', tiles });
      return;
    }

    const result = this.game.exchange(tiles);
    this.cancelExchange();

    if (!result.ok) {
      this.toast(result.reason, 'error');
      return;
    }
    this.toast(`${tiles.length} jeton${tiles.length > 1 ? 's' : ''} échangé${tiles.length > 1 ? 's' : ''}.`);
    this.save();
    this.render();
    this.broadcast();
    this.afterTurn();
  }

  resign() {
    if (this.mode === 'guest') {
      this.session?.send({ t: 'resign' });
      return;
    }
    this.game.finished = true;
    this.game.winner = COMPUTER;
    this.game.endReason =
      this.mode === 'solo'
        ? 'Vous avez abandonné la partie.'
        : `${this.myName} a abandonné la partie.`;
    this.save();
    this.render();
    this.broadcast();
    this.showEnd();
  }

  newGame() {
    if (this.mode === 'host') {
      this.startNetworkGame();
      return;
    }
    if (this.mode === 'guest') {
      this.session?.send({ t: 'rematch' });
      this.toast('Revanche proposée à votre adversaire.');
      return;
    }
    this.game = new Game({ level: this.level });
    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.cancelExchange();
    this.save();
    this.render();
    this.toast('Nouvelle partie. À vous l’honneur.');
  }

  askHint() {
    const id = ++this.requestId;
    this.pendingRequests.set(id, 'hint');
    this.busy = true;
    this.renderControls();
    this.worker.postMessage({
      type: 'hint',
      id,
      board: { letters: [...this.game.board.letters], blanks: [...this.game.board.blanks] },
      rack: [...this.game.players[HUMAN].rack],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Tour de l'adversaire                                              */
  /* ---------------------------------------------------------------- */

  afterTurn() {
    if (this.game.finished) {
      this.showEnd();
      return;
    }
    if (this.mode === 'solo' && this.game.current === COMPUTER) this.runComputerTurn();
  }

  runComputerTurn() {
    this.busy = true;
    $('thinking').hidden = false;
    this.renderControls();
    this.renderScores();

    const id = ++this.requestId;
    this.pendingRequests.set(id, 'move');
    this.thinkingSince = performance.now();

    this.worker.postMessage({
      type: 'move',
      id,
      board: { letters: [...this.game.board.letters], blanks: [...this.game.board.blanks] },
      rack: [...this.game.players[COMPUTER].rack],
      level: this.level,
      bagCount: this.game.bagCount,
    });
  }

  async onWorkerMessage(message) {
    if (message.type === 'error') {
      this.busy = false;
      $('thinking').hidden = true;
      this.toast(`Erreur du moteur : ${message.message}`, 'error');
      this.render();
      return;
    }

    const kind = this.pendingRequests.get(message.id);
    if (!kind) return;
    this.pendingRequests.delete(message.id);

    if (message.type === 'hint') {
      this.busy = false;
      const move = message.move;
      if (!move) this.toast('Aucun coup possible avec ce chevalet.', 'error');
      else {
        const main = move.words.reduce((a, b) => (a.word.length >= b.word.length ? a : b));
        this.toast(`${main.word} en ${coordName(move.placements[0].row * SIZE + move.placements[0].col)} — ${move.score} points`);
      }
      this.renderControls();
      return;
    }

    // Un temps de réflexion minimal évite un coup qui « claque » sans transition.
    const elapsed = performance.now() - this.thinkingSince;
    if (elapsed < MIN_THINKING_MS) await new Promise((r) => setTimeout(r, MIN_THINKING_MS - elapsed));

    this.applyComputerDecision(message.decision);
  }

  applyComputerDecision(decision) {
    const name = this.game.players[COMPUTER].name;

    if (decision.type === 'play') {
      const result = this.game.play(decision.move.placements, this.dawg);
      if (result.ok) {
        this.revealCells = [...this.game.lastMoveCells];
        this.revealKind = 'land';
        const words = result.words.map((w) => w.word).join(', ');
        this.toast(result.bingo ? `${name} scrabble : ${words} (+${result.score})` : `${name} : ${words} (+${result.score})`);
        if (result.bingo) this.replay(this.boardEl, 'bingo');
      } else {
        // Garde-fou : plutôt passer que bloquer la partie sur un coup rejeté.
        this.game.pass();
        this.toast(`${name} passe son tour.`);
      }
    } else if (decision.type === 'exchange') {
      const result = this.game.exchange(decision.tiles);
      if (!result.ok) this.game.pass();
      this.toast(`${name} échange ${decision.tiles.length} jeton${decision.tiles.length > 1 ? 's' : ''}.`);
    } else {
      this.game.pass();
      this.toast(`${name} passe son tour.`);
    }

    this.busy = false;
    $('thinking').hidden = true;
    this.save();
    this.render();

    if (this.game.finished) this.showEnd();
  }

  /* ---------------------------------------------------------------- */
  /* Fin de partie                                                     */
  /* ---------------------------------------------------------------- */

  showEnd() {
    const [human, ai] = this.game.players;
    $('end-title').textContent = this.endSentence();
    $('end-detail').textContent = this.game.endReason ?? '';
    $('end-scores').innerHTML =
      `<div class="${this.game.winner === HUMAN ? 'won' : ''}"><div class="n">Vous</div><div class="v">${human.score}</div></div>` +
      `<div class="${this.game.winner === COMPUTER ? 'won' : ''}"><div class="n">${ai.name}</div><div class="v">${ai.score}</div></div>`;
    $('end-dialog').showModal();
    if (this.mode !== 'solo') return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* rien à nettoyer */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Partie à deux                                                     */
  /* ---------------------------------------------------------------- */
  /*
   * L'hôte fait autorité : il détient le sac et les deux chevalets, valide
   * les coups et diffuse l'état après chaque tour. L'invité n'envoie que des
   * intentions et affiche ce qu'on lui transmet.
   *
   * Les instantanés sont exprimés du point de vue du destinataire, qui s'y
   * voit toujours en position 0 : tout le rendu reste identique au solo.
   */

  bindNetwork() {
    // Clin d'œil : la marque se déhanche quand on la touche.
    document.querySelector('.brand').addEventListener('click', () => this.wiggleBrand());

    $('btn-multi').onclick = () => this.openMultiplayer();
    $('mp-close').onclick = () => $('mp-dialog').close();

    const nameField = $('mp-name');
    nameField.value = this.myName;
    nameField.onchange = () => {
      this.myName = nameField.value.trim().slice(0, 18) || 'Joueur';
      nameField.value = this.myName;
      try {
        localStorage.setItem(NAME_KEY, this.myName);
      } catch {
        /* stockage indisponible : le nom vaudra pour cette session */
      }
    };

    $('mp-create').onclick = () => {
      nameField.onchange();
      this.startHosting();
    };

    const codeField = $('mp-code');
    codeField.oninput = () => {
      codeField.value = normalizeCode(codeField.value);
    };
    $('mp-join').onclick = () => {
      nameField.onchange();
      this.startJoining(codeField.value);
    };

    $('mp-copy').onclick = async () => {
      const link = inviteLink(this.session?.code ?? '');
      try {
        await navigator.clipboard.writeText(link);
        this.toast('Lien d’invitation copié.');
      } catch {
        // Le presse-papiers peut être refusé hors contexte sécurisé : on
        // affiche alors le lien pour une copie manuelle.
        this.setNetStatus(link);
      }
    };

    $('mp-leave').onclick = () => {
      $('mp-dialog').close();
      this.leaveMultiplayer();
    };

    // Un lien d'invitation ouvre directement la fenêtre de connexion.
    const invited = codeFromLocation();
    if (invited) {
      codeField.value = invited;
      $('mp-dialog').showModal();
      this.startJoining(invited);
    }
  }

  /** Fait onduler les jetons de la marque, de gauche à droite. */
  wiggleBrand() {
    if (reducedMotion.matches) return;
    const tiles = [...document.querySelectorAll('.brand-tile')];

    tiles.forEach((tile, i) => {
      tile.classList.remove('wiggle');
      tile.style.animationDelay = `${i * 32}ms`;
    });
    // Recalcul forcé : sans lui, retirer puis remettre la classe dans la même
    // image ne relance pas l'animation.
    void tiles[0]?.offsetWidth;
    for (const tile of tiles) tile.classList.add('wiggle');
  }

  openMultiplayer() {
    $('mp-choice').hidden = this.mode !== 'solo';
    $('mp-invite').hidden = this.mode !== 'host' || !this.session?.code;
    $('mp-leave').hidden = this.mode === 'solo';
    if (this.mode === 'solo') this.setNetStatus('');
    $('mp-dialog').showModal();
  }

  /* --- Établissement de la liaison --------------------------------- */

  startHosting() {
    this.teardownSession();
    this.mode = 'host';
    this.opponentName = 'Adversaire';

    this.session = new PeerSession({
      onStatus: (text) => this.setNetStatus(text),
      onReady: (code) => {
        $('mp-choice').hidden = true;
        $('mp-invite').hidden = false;
        $('mp-leave').hidden = false;
        $('mp-code-value').textContent = code;
      },
      onConnected: () => this.setNetStatus('Adversaire connecté, préparation…', 'live'),
      onData: (message) => this.onPeerData(message),
      onClosed: (reason) => this.onPeerLost(reason),
      onError: (message) => this.onPeerError(message),
    });

    this.session.host();
    this.renderNetChip();
  }

  startJoining(code) {
    this.teardownSession();
    this.mode = 'guest';
    this.opponentName = 'Adversaire';

    this.session = new PeerSession({
      onStatus: (text) => this.setNetStatus(text),
      onConnected: () => {
        this.setNetStatus('Connecté. En attente de la partie…', 'live');
        $('mp-choice').hidden = true;
        $('mp-leave').hidden = false;
        // Le code a rempli son office : on le retire de l'adresse pour qu'un
        // rechargement ne relance pas une connexion vers une partie close.
        clearLocationCode();
        this.session.send({ t: 'hello', name: this.myName });
      },
      onData: (message) => this.onPeerData(message),
      onClosed: (reason) => this.onPeerLost(reason),
      onError: (message) => this.onPeerError(message),
    });

    this.session.join(code);
    this.renderNetChip();
  }

  /** Nouvelle partie en ligne : seul l'hôte la crée, puis la diffuse. */
  startNetworkGame() {
    const first = Math.random() < 0.5 ? HUMAN : COMPUTER;
    this.game = new Game({
      firstPlayer: first,
      humanName: this.myName,
      computerName: this.opponentName,
    });

    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.cancelExchange();
    this.shownScores = [0, 0];

    this.session.send({ t: 'welcome', name: this.myName });
    this.render();
    this.broadcast();
    $('mp-dialog').close();
    this.toast(
      first === HUMAN ? 'Partie lancée : à vous l’honneur.' : `Partie lancée : ${this.opponentName} commence.`,
    );
  }

  /* --- Échange de messages ----------------------------------------- */

  /** Diffuse l'état courant à l'invité. */
  broadcast() {
    if (this.mode !== 'host' || !this.session?.connected) return;
    this.session.send({ t: 'state', snap: this.game.snapshot(COMPUTER) });
  }

  sendIntent(intent) {
    if (!this.session?.connected) {
      this.toast('Liaison perdue : votre coup n’a pas pu être envoyé.', 'error');
      return;
    }
    this.session.send(intent);
    this.busy = true;
    this.renderControls();
  }

  onPeerData(message) {
    switch (message.t) {
      case 'hello':
        if (this.mode !== 'host') return;
        this.opponentName = this.cleanName(message.name);
        this.startNetworkGame();
        return;

      case 'welcome':
        if (this.mode !== 'guest') return;
        this.opponentName = this.cleanName(message.name);
        this.renderScores();
        return;

      case 'state':
        if (this.mode !== 'guest') return;
        this.applySnapshot(message.snap);
        return;

      case 'reject':
        if (this.mode !== 'guest') return;
        this.busy = false;
        this.toast(String(message.reason ?? 'Coup refusé.'), 'error');
        this.refresh();
        return;

      case 'busy':
        this.toast('Cette partie a déjà deux joueurs.', 'error');
        this.leaveMultiplayer();
        return;

      case 'play':
      case 'pass':
      case 'exchange':
      case 'resign':
      case 'rematch':
        if (this.mode === 'host') this.handleGuestIntent(message);
        return;

      default:
        return;
    }
  }

  /**
   * Arbitrage d'une intention reçue de l'invité. Le contenu vient du réseau :
   * il est ramené à des valeurs sûres avant d'atteindre le moteur, qui
   * revérifie de toute façon chevalet, géométrie et dictionnaire.
   */
  handleGuestIntent(message) {
    if (message.t === 'rematch') {
      this.startNetworkGame();
      return;
    }

    if (message.t === 'resign') {
      this.game.finished = true;
      this.game.winner = HUMAN;
      this.game.endReason = `${this.opponentName} a abandonné la partie.`;
      this.render();
      this.broadcast();
      this.showEnd();
      return;
    }

    if (this.game.finished || this.game.current !== COMPUTER) {
      this.session.send({ t: 'reject', reason: 'Ce n’est pas votre tour.' });
      return;
    }

    let result;
    if (message.t === 'play') {
      result = this.game.play(this.safePlacements(message.placements), this.dawg);
    } else if (message.t === 'exchange') {
      result = this.game.exchange(this.safeTiles(message.tiles));
    } else {
      result = this.game.pass();
    }

    if (!result.ok) {
      this.session.send({ t: 'reject', reason: result.reason });
      return;
    }

    if (message.t === 'play') {
      this.revealCells = [...this.game.lastMoveCells];
      this.revealKind = 'land';
      const words = result.words.map((w) => w.word).join(', ');
      this.toast(
        result.bingo
          ? `Scrabble de ${this.opponentName} ! ${words} — ${result.score} points`
          : `${this.opponentName} : ${words} — ${result.score} points`,
      );
      if (result.bingo) this.replay(this.boardEl, 'bingo');
    } else if (message.t === 'exchange') {
      this.toast(`${this.opponentName} a échangé des jetons.`);
    } else {
      this.toast(`${this.opponentName} passe son tour.`);
    }

    this.render();
    this.broadcast();
    this.afterTurn();
  }

  /** Applique un instantané reçu de l'hôte. */
  applySnapshot(snap) {
    const before = this.game?.history?.length ?? 0;
    this.game = Game.fromSnapshot(snap);
    this.opponentName = snap.names[1];

    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.busy = false;
    this.cancelExchange();

    const entry = snap.history.length > before ? snap.history.at(-1) : null;
    if (entry && entry.player === COMPUTER) {
      this.revealCells = [...(snap.lastMoveCells ?? [])];
      this.revealKind = 'land';
      if (entry.type === 'play') {
        const words = entry.words.join(', ');
        this.toast(
          entry.bingo
            ? `Scrabble de ${this.opponentName} ! ${words} — ${entry.score} points`
            : `${this.opponentName} : ${words} — ${entry.score} points`,
        );
        if (entry.bingo) this.replay(this.boardEl, 'bingo');
      } else if (entry.type === 'exchange') {
        this.toast(`${this.opponentName} a échangé des jetons.`);
      } else {
        this.toast(`${this.opponentName} passe son tour.`);
      }
    }

    $('mp-dialog').close();
    this.render();
    if (this.game.finished) this.showEnd();
  }

  /* --- Assainissement des messages reçus ---------------------------- */

  cleanName(raw) {
    const name = String(raw ?? '').trim().slice(0, 18);
    return name || 'Adversaire';
  }

  safePlacements(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, 7)
      .map((p) => ({
        row: Math.trunc(Number(p?.row)),
        col: Math.trunc(Number(p?.col)),
        letter: Math.trunc(Number(p?.letter)),
        blank: Boolean(p?.blank),
      }))
      .filter(
        (p) =>
          Number.isInteger(p.row) &&
          Number.isInteger(p.col) &&
          Number.isInteger(p.letter) &&
          p.row >= 0 &&
          p.row < SIZE &&
          p.col >= 0 &&
          p.col < SIZE &&
          p.letter >= 0 &&
          p.letter <= 25,
      );
  }

  safeTiles(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, 7)
      .map((t) => Math.trunc(Number(t)))
      .filter((t) => Number.isInteger(t) && t >= 0 && t <= BLANK);
  }

  /* --- Rupture et sortie -------------------------------------------- */

  onPeerLost(reason) {
    this.busy = false;
    this.toast(reason, 'error');
    this.setNetStatus(reason, 'error');
    $('mp-choice').hidden = true;
    $('mp-leave').hidden = false;
    this.render();
  }

  onPeerError(message) {
    this.busy = false;
    this.setNetStatus(message, 'error');
    $('mp-choice').hidden = false;
    $('mp-invite').hidden = true;
    this.mode = 'solo';
    this.renderNetChip();
  }

  leaveMultiplayer() {
    this.teardownSession();
    this.mode = 'solo';
    this.opponentName = 'Adversaire';
    clearLocationCode();
    this.setNetStatus('');
    $('mp-choice').hidden = false;
    $('mp-invite').hidden = true;
    $('mp-leave').hidden = true;

    // La partie solo laissée en plan a été préservée pendant la partie en
    // ligne : on la reprend plutôt que d'en démarrer une autre.
    this.game = this.restore() ?? new Game({ level: this.level });
    this.level = this.game.level;
    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.cancelExchange();
    this.shownScores = this.game.players.map((p) => p.score);

    this.render();
    this.toast('Retour à la partie solo.');
    if (this.game.current === COMPUTER && !this.game.finished) this.runComputerTurn();
  }

  teardownSession() {
    this.session?.destroy();
    this.session = null;
  }

  setNetStatus(text, kind = '') {
    const status = $('mp-status');
    status.textContent = text;
    status.className = `mp-status ${kind}`.trim();
  }

  renderNetChip() {
    const chip = $('netchip');
    if (this.mode === 'solo') {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    const live = Boolean(this.session?.connected);
    chip.className = `netchip ${live ? 'live' : 'lost'}`;
    chip.textContent = live ? this.opponentName : 'Hors ligne';
  }

  /* ---------------------------------------------------------------- */

  toast(text, kind = '') {
    const toast = $('toast');
    toast.textContent = text;
    toast.className = `toast ${kind}`.trim();
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }
}
