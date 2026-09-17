/**
 * Contrôleur de l'interface : rendu du plateau, saisie tactile et clavier,
 * enchaînement des tours avec l'adversaire calculé dans un worker.
 */
import {
  SIZE,
  CELLS,
  CENTER,
  BLANK,
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
const MIN_THINKING_MS = 450;

/** Décalage entre deux jetons lors de la révélation d'un coup. */
const REVEAL_STEP_MS = 60;
const SCORE_COUNT_MS = 520;

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
        `<span class="level-badge">${difficulty.level}</span>` +
        `<span class="level-text"><span class="level-name">${difficulty.name}</span>` +
        `<span class="level-blurb">${difficulty.blurb}</span></span>`;
      option.addEventListener('click', () => {
        this.level = difficulty.level;
        this.game.level = difficulty.level;
        this.save();
        this.renderLevels();
        this.renderScores();
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
        cell.append(this.tileElement(pending.letter, pending.blank, 'tile pending fresh'));
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

        this.attachDrag(tile, i);
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
    $('ai-name').textContent = `${difficultyByLevel(this.level).name} · niv. ${this.level}`;
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
    const myTurn = this.game.current === HUMAN && !this.game.finished && !this.busy;
    const hasPending = this.pending.size > 0;

    $('btn-play').disabled = !myTurn || !hasPending;
    $('btn-recall').disabled = !hasPending;
    $('btn-shuffle').disabled = !myTurn;
    $('btn-hint').disabled = !myTurn;
    $('btn-more').disabled = !myTurn;

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
    if (this.game.current !== HUMAN) {
      status.textContent = 'Au tour de votre adversaire.';
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
    return this.game.winner === HUMAN ? 'Vous gagnez !' : 'Centurion l’emporte.';
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
  attachDrag(tile, rackIndex) {
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
        tile.classList.add('dragging');
        const box = tile.getBoundingClientRect();
        ghost = tile.cloneNode(true);
        ghost.className = 'drag-ghost';
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
        ghost.style.fontSize = getComputedStyle(tile).fontSize;
        document.body.append(ghost);
      }
      ghost.style.left = `${event.clientX}px`;
      ghost.style.top = `${event.clientY}px`;
    };

    const onUp = (event) => {
      tile.removeEventListener('pointermove', onMove);
      tile.removeEventListener('pointerup', onUp);
      tile.removeEventListener('pointercancel', onUp);
      tile.classList.remove('dragging');

      if (!dragging) {
        this.selectRackTile(rackIndex);
        return;
      }

      ghost?.remove();
      ghost = null;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.cell');
      if (target && !this.exchangeMode) {
        const index = Number(target.dataset.index);
        if (this.game.board.letters[index] < 0 && !this.pending.has(index)) {
          this.placeTile(index, rackIndex);
          return;
        }
      }
      this.refresh();
    };

    tile.addEventListener('pointerdown', (event) => {
      if (this.game.finished || this.busy || this.game.current !== HUMAN) return;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      try {
        tile.setPointerCapture(event.pointerId);
      } catch {
        /* pointeur déjà relâché : le suivi reste correct sans capture */
      }
      tile.addEventListener('pointermove', onMove);
      tile.addEventListener('pointerup', onUp);
      tile.addEventListener('pointercancel', onUp);
    });
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

    $('btn-rules').onclick = () => $('rules-dialog').showModal();
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
    this.afterTurn();
  }

  passTurn() {
    this.recall();
    this.game.pass();
    this.save();
    this.render();
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
    const result = this.game.exchange(tiles);
    this.cancelExchange();

    if (!result.ok) {
      this.toast(result.reason, 'error');
      return;
    }
    this.toast(`${tiles.length} jeton${tiles.length > 1 ? 's' : ''} échangé${tiles.length > 1 ? 's' : ''}.`);
    this.save();
    this.render();
    this.afterTurn();
  }

  resign() {
    this.game.finished = true;
    this.game.winner = COMPUTER;
    this.game.endReason = 'Vous avez abandonné la partie.';
    this.save();
    this.render();
    this.showEnd();
  }

  newGame() {
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
    if (this.game.current === COMPUTER) this.runComputerTurn();
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
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* rien à nettoyer */
    }
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
