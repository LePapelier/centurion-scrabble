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
import { Game, HUMAN, COMPUTER, MIN_PLAYERS, MAX_PLAYERS } from '../core/game.js';
import { validateMove } from '../core/board.js';
import { Sons } from './sons.js';
import {
  PeerSession,
  inviteLink,
  codeFromLocation,
  clearLocationCode,
  normalizeCode,
  myToken,
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
const THEME_KEY = 'centurion-scrabble/theme';

/**
 * Les décors proposés. Chacun n'est qu'un jeu de variables CSS, posé sur
 * `<html>` : la mise en page, les proportions des tuiles et les règles ne
 * changent jamais. Voir les blocs `[data-theme]` dans `styles.css`.
 *
 * Chaque thème porte une icône plutôt qu'une palette : trois bandes de
 * couleur disent qu'un décor est bleu ou brun, elles ne disent pas qu'il est
 * sous l'eau ou dans l'espace. Un dessin le dit d'un coup, et dispense de la
 * ligne de description qui était là pour rattraper la pastille.
 */
const THEMES = [
  // Une tuile, pour le jeu tel qu'on le connaît.
  {
    id: 'classique',
    name: 'Classique',
    icon: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="2.6"/>'
      + '<path d="M9.5 15.6 12 8.8l2.5 6.8"/><path d="M10.4 13.6h3.2"/>',
  },
  // Un casque à cimier. La couronne de laurier, essayée d'abord, passait pour
  // un masque : deux arcs qui se referment font un visage, et les deux feuilles
  // à l'intérieur faisaient les yeux.
  {
    id: 'centurion',
    name: 'Centurion',
    icon: '<path d="M5 20.6v-5.3a7 7 0 0 1 14 0v5.3"/>'
      + '<path d="M5 16.6h14"/>'
      + '<path d="M8.2 10C9 4.9 10.3 2.7 12 2.7s3 2.2 3.8 7.3"/>',
  },
  // Une planète annelée et une étoile, comme le décor du thème.
  {
    id: 'espace',
    name: 'Espace',
    icon: '<circle cx="11.2" cy="13" r="5.4"/>'
      + '<ellipse cx="11.2" cy="13" rx="9.4" ry="2.9" transform="rotate(-22 11.2 13)"/>'
      + '<path d="M19.4 4v3.2M17.8 5.6h3.2"/>',
  },
  // Une goutte : de l'eau et du verre, et rien qui ressemble à la planète.
  //
  // Le nom montré est « Aqua », l'identifiant reste `verre`. Celui-ci est
  // écrit dans le stockage du navigateur, dans l'attribut `data-theme`, dans
  // les sélecteurs CSS, dans les noms des deux fichiers de décor et dans la
  // table des timbres : le changer obligerait à migrer la préférence déjà
  // enregistrée, pour un renommage qui ne regarde que l'affichage.
  {
    id: 'verre',
    name: 'Aqua',
    icon: '<path d="M12 3.4c3.7 5 5.6 8.2 5.6 9.9a5.6 5.6 0 0 1-11.2 0c0-1.7 1.9-4.9 5.6-9.9Z"/>'
      + '<path d="M9.2 14.2a3 3 0 0 0 1.6 2.5"/>',
  },
];
const NAME_KEY = 'centurion-scrabble/nom';
const SON_KEY = 'centurion-scrabble/son';
/** Nom montré à l'adversaire quand le joueur n'en a choisi aucun. */
const DEFAULT_NAME = 'Joueur';
/**
 * Temps de réflexion affiché avant que le coup de l'adversaire n'apparaisse.
 *
 * Le moteur répond en quelques dizaines de millisecondes : sans attente, le
 * coup surgit avant qu'on ait fini de lire le plateau, et on ne voit pas ce
 * qui a changé. Le plancher laisse le temps de suivre, et la part aléatoire
 * évite que chaque tour dure exactement pareil — c'est ce battement régulier,
 * plus que la vitesse, qui trahissait la machine.
 */
const THINKING_FLOOR_MS = 900;
const THINKING_JITTER_MS = 700;

/**
 * Félicitations quand le joueur trouve le coup qui rapporte le plus.
 *
 * Le seuil existe parce qu'on ne félicite pas quelqu'un qui n'avait pas le
 * choix : en fin de partie il ne reste parfois que deux coups possibles, et
 * jouer le meilleur des deux n'est pas un exploit. En dessous, on se tait.
 */
const MIN_COUPS_POUR_FELICITER = 6;
/** Temps laissé à la félicitation avant que l'adversaire ne joue par-dessus. */
const FELICITATION_MS = 2000;
/** Décalage entre deux tuiles qui s'allument, quand le coup est salué. */
const ETINCELLE_PAS_MS = 70;
/* Une seule formule, courte. Quatre tournures tournaient ici : la variété
   attirait l'œil sur le texte, alors que l'intérêt est ailleurs — dans les
   tuiles qui s'allument. Et sur un téléphone, une phrase plus longue s'étale
   sur trois lignes et n'a plus rien d'une petite tape dans le dos. */
const FELICITATION = 'Meilleur coup !';
/* L'autre façon de bien jouer : le coup qui laisse le meilleur chevalet, quitte
   à rapporter moins que le maximum. C'est le critère du Centurion, et sur la
   durée d'une partie il pèse plus lourd que quelques points grappillés.

   Il porte donc son nom. « Coup stratégique » décrivait la manière et non le
   rang — on pouvait le lire comme un compliment sur le style, alors qu'il
   s'agit bien du meilleur coup de la position. Le Centurion, c'est le niveau
   qui ne laisse rien passer : dire qu'on a joué le sien, c'est dire qu'on a
   trouvé ce que joue la machine la plus forte. */
const FELICITATION_STRATEGIQUE = 'Le coup du Centurion !';
/* Les valeurs stratégiques sont des flottants : on ne compare jamais deux
   nombres de ce genre au dernier bit près. */
const EGALITE_STRATEGIQUE = 0.01;

/** Décalage entre deux tuiles lors de la révélation d'un coup. */
const REVEAL_STEP_MS = 60;

/**
 * Temps laissé au joueur pour lire « aucun coup possible » avant que son
 * tour ne soit passé d'office. Assez pour comprendre ce qui se passe, assez
 * court pour ne pas donner l'impression que le jeu a planté.
 */
const BLOCAGE_MS = 1600;

/**
 * Réactions d'un seul appui. Huit, pas davantage : elles doivent tenir sur
 * une rangée à la largeur d'un téléphone, et se choisir sans lire. Elles
 * couvrent ce qu'on se dit vraiment pendant une partie — l'approbation, la
 * surprise devant un coup, le dépit, et le mot qu'on n'attendait pas.
 */
const EMOJIS = ['👍', '😂', '😮', '🤯', '😭', '🔥', '🎉', '🤔'];

/** Longueur maximale d'un message, et profondeur du fil conservé. */
const CHAT_MAX = 140;
const CHAT_MEMORY = 60;
/** Bulles montrées simultanément au-dessus du plateau, et leur durée. */
const BUBBLE_STACK = 3;
const BUBBLE_MS = 4200;
/** Décalage entre deux lettres de la marque quand elle ondule. */
const BRAND_WAVE_STEP_MS = 18;
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

/**
 * L'étoile de la case centrale.
 *
 * Elle était écrite — le caractère « ★ » — et dépendait donc de la police du
 * thème. Or celle-ci change avec lui : en monospace, sur le thème Espace, le
 * glyphe sortait plus petit que sur les autres et calé plus haut. Un dessin
 * ne dépend d'aucune police, et se mesure en part de la case.
 *
 * Cinq branches, rayon extérieur 9,6 et intérieur 3,67 — le rapport d'or
 * inverse, qui est celui de l'étoile régulière.
 */
const etoileCentrale = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'etoile');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2.4 14.16 9.03 21.13 9.03 15.49 13.13 17.64 19.77'
    + ' 12 15.67 6.36 19.77 8.51 13.13 2.87 9.03 9.84 9.03Z');
  svg.append(path);
  return svg;
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
    /** Une recherche de blocage est en cours : une seule à la fois. */
    this.blocageEnCours = false;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.toastTimer = null;

    /**
     * Bruitages. Le réglage est retenu d'une partie sur l'autre ; en son
     * absence, le son est actif — c'est un jeu, et le bouton est en évidence
     * dans l'en-tête pour qui préfère le silence.
     */
    let sonActif = true;
    try {
      sonActif = localStorage.getItem(SON_KEY) !== 'off';
    } catch {
      /* stockage indisponible : on garde le réglage par défaut */
    }
    /* Le thème est déjà posé sur `<html>` par le script de l'en-tête : on le
       lit là plutôt que de relire le stockage, et le son part de la bonne
       matière dès le premier claquement. */
    this.theme = document.documentElement.dataset.theme || 'classique';
    this.sons = new Sons(sonActif, this.theme);
    this.sons.surveiller();

    /** Coup en attente d'un verdict d'optimalité : {id, score}. */
    this.attenteOptimalite = null;
    /** Instant jusqu'auquel l'adversaire laisse lire une félicitation. */
    this.felicitationJusqua = 0;

    /** Cases à animer au prochain rendu, dans l'ordre de la pose. */
    this.revealCells = [];
    this.revealKind = 'settle';
    /** Index du chevalet déjà affichés, pour n'animer que les nouveaux. */
    this.rackShown = new Set();
    this.forceRackPop = false;
    this.shownScores = [];
    this.scoreFrames = [];
    /** Une entrée par carte de score : {card, name, value}. */
    this.scoreCards = null;
    this.haloScore = null;
    /** Halos de mot, du plus long au plus court ; le premier vient du balisage. */
    this.halos = [];
    this.dragEndedAt = 0;
    /** Glissement en cours : {stop}. Un rendu doit pouvoir le défaire. */
    this.activeDrag = null;
    this.dropCell = null;
    this.dropSource = null;

    /** 'solo' face à l'IA, 'host' ou 'guest' en partie en ligne. */
    this.mode = 'solo';
    this.session = null;
    /** Une partie en réseau a été lancée : un « hello » vaut alors retour. */
    this.netStarted = false;
    /** Places de la table en ligne, hôte en tête. */
    this.seats = [];
    /** Nombre de joueurs voulu par l'hôte, de deux à quatre. */
    this.tableSize = MIN_PLAYERS;
    /** Composition de la table telle que l'hôte l'annonce, côté invité. */
    this.lobbyNames = [];
    this.lobbySize = 0;
    /** Fil du tchat : {from, text, mine}. */
    this.chat = [];
    /** Messages arrivés pendant que la fenêtre du tchat était fermée. */
    this.unread = 0;
    // Vide tant que le joueur n'a rien choisi : le champ doit s'offrir libre,
    // et non demander qu'on efface un nom qu'on n'a pas mis. Les versions
    // précédentes enregistraient le nom par défaut dès la première ouverture :
    // on ne le prend pas pour un choix.
    const enregistre = localStorage.getItem(NAME_KEY) ?? '';
    this.myName = enregistre === DEFAULT_NAME ? '' : enregistre;

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
    this.buildThemes();
    this.bindActions();
    this.bindKeyboard();
    this.bindSaisieTactile();

    // Une partie reprise affiche ses scores tels quels, sans les recompter.
    this.shownScores = this.game.players.map((p) => p.score);
    window.addEventListener('resize', () => this.updateHalo());

    this.bindNetwork();

    this.render();
    if (this.game.current === COMPUTER && !this.game.finished) this.runComputerTurn();
    else this.verifierBlocage();
  }

  buildBoard() {
    const board = $('board');
    this.boardEl = board;
    this.halos = [$('halo')];
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

    /* Les repères de coordonnées, posés dans le cadre.

       La notation est celle du Scrabble français : les lignes portent les
       lettres A à O de haut en bas, les colonnes les chiffres 1 à 15 de gauche
       à droite. C'est ce qui permet d'écrire « H4 » pour un mot horizontal et
       « 4H » pour un mot vertical parti de la même case — l'ordre dit le sens,
       et il ne le dirait plus si on échangeait les deux axes.

       Les deux réglettes sont des calques posés sur le cadre, et non des
       lignes de la grille : le plateau est un `grid` de quinze sur quinze, et
       y ajouter une rangée décalerait toutes les cases. Elles reprennent le
       même pas et le même écart, ce qui les aligne sans rien calculer. */
    const colonnes = document.createElement('div');
    colonnes.className = 'reglette reglette-colonnes';
    const lignes = document.createElement('div');
    lignes.className = 'reglette reglette-lignes';
    for (const r of [colonnes, lignes]) r.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < SIZE; i++) {
      const chiffre = document.createElement('span');
      chiffre.textContent = String(i + 1);
      colonnes.append(chiffre);
      const lettre = document.createElement('span');
      lettre.textContent = String.fromCharCode(65 + i);
      lignes.append(lettre);
    }
    board.append(colonnes, lignes);

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
      // Le bouton montre la tuile telle qu'elle se posera : la lettre seule, sans
      // valeur en coin, un joker n'en portant pas.
      button.append(document.createTextNode(letterChar(letter)));

      // Le choix se prend au premier contact. `pointerup` devance le clic sur
      // mobile, où celui-ci peut se perdre après l'ouverture de la fenêtre ;
      // `click` reste pour le clavier. Le second à survenir ne fait rien,
      // `resolveBlank` étant vidé par le premier.
      const choisir = () => this.resolveBlank?.(letter);
      button.addEventListener('pointerup', choisir);
      button.addEventListener('click', choisir);
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
        // La partie en cours change d'adversaire : son nom doit suivre. En
        // ligne il n'y a pas d'adversaire calculé, et le siège 1 appartient
        // à quelqu'un : on n'y touche pas.
        if (this.mode === 'solo') this.game.players[COMPUTER].name = difficulty.name;
        this.save();
        this.renderLevels();
        this.renderScores();
        $('rules-dialog').close();
        this.toast(`Adversaire : ${difficulty.name}`);
      });
      container.append(option);
    }
  }

  buildThemes() {
    const container = $('themes');
    for (const theme of THEMES) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'theme-option';
      option.dataset.theme = theme.id;
      option.innerHTML =
        `<span class="level-badge"><svg viewBox="0 0 24 24" aria-hidden="true">${theme.icon}</svg></span>` +
        `<span class="level-name">${theme.name}</span>`;
      option.addEventListener('click', () => this.choisirTheme(theme.id));
      container.append(option);
    }
    this.renderThemes();
  }

  /** Pose un thème, le retient, et met à jour la coche. */
  choisirTheme(id) {
    this.theme = id;
    const racine = document.documentElement;
    // Le thème par défaut n'écrit pas d'attribut : il est le `:root` nu.
    if (id === 'classique') racine.removeAttribute('data-theme');
    else racine.setAttribute('data-theme', id);
    // La matière du décor s'entend aussi : le timbre suit.
    this.sons.setTimbre(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch {
      // Stockage refusé (navigation privée) : le thème vaut pour la session.
    }
    this.renderThemes();
  }

  renderThemes() {
    const actuel = this.theme ?? document.documentElement.dataset.theme ?? 'classique';
    for (const option of $('themes').children) {
      option.classList.toggle('selected', option.dataset.theme === actuel);
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
    // Les tuiles posées sont déplaçables : les reconstruire emporterait celle
    // qu'on tient. Un glissement parti du chevalet, lui, n'est pas concerné —
    // c'est `renderRack` qui décide de son sort.
    this.cancelDrag('board');
    // Plus de point de saisie, plus de raison d'avoir un clavier à l'écran.
    // Ici plutôt qu'aux vingt endroits qui remettent le curseur à zéro.
    if (!this.cursor) this.fermerClavierTactile();
    const { letters, blanks } = this.game.board;
    const highlight = new Set(this.game.lastMoveCells);

    for (let i = 0; i < CELLS; i++) {
      const cell = this.cells[i];
      const pending = this.pending.get(i);
      const letter = letters[i];

      cell.classList.toggle('highlight', highlight.has(i) && letter >= 0);
      // Le point de saisie clavier, et le sens dans lequel la frappe avance :
      // sans ce second repère, on ne sait pas si la lettre suivante ira à
      // droite ou en dessous, et il faut taper pour l'apprendre.
      const curseurIci = this.cursor?.index === i && letter < 0 && !pending;
      cell.classList.toggle('cursor', curseurIci);
      cell.classList.toggle('cursor-bas', curseurIci && this.cursor.direction === 1);

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
        cell.append(etoileCentrale());
      } else if (PREMIUM_LABEL[PREMIUMS[i]]) {
        cell.textContent = PREMIUM_LABEL[PREMIUMS[i]];
      }
    }

    this.revealCells = [];
  }

  /**
   * Cerne les mots en cours dès que le coup est jouable, et renvoie le
   * verdict complet.
   *
   * Tous les mots formés sont cernés, pas seulement le plus long : un coup
   * qui achève un mot croisé le compte dans son score, il doit donc le
   * montrer. Le plus long porte la pastille, qui annonce le total du coup.
   *
   * @returns {object|null}
   */
  updateHalo() {
    const badge = $('halo-score');

    const active = this.pending.size > 0 && this.game.current === HUMAN && !this.game.finished;
    const verdict = active ? validateMove(this.game.board, this.placements(), this.dawg) : null;

    if (!verdict?.ok) {
      this.hideHalos();
      badge.hidden = true;
      this.haloScore = null;
      return verdict;
    }

    // Le plus long d'abord : il reçoit le halo qui porte la pastille, et
    // l'ordre reste stable pendant que le joueur complète son mot, ce qui
    // laisse les déplacements se faire en transition plutôt qu'en saut.
    const words = [...verdict.words].sort((a, b) => b.cells.length - a.cells.length);
    const board = this.boardEl.getBoundingClientRect();
    const pad = Math.max(2, board.width * 0.006);

    const wasHidden = this.halos[0].hidden;
    // Emprises des halos, retenues pour y poser le score ensuite.
    const emprises = [];

    words.forEach((word, rank) => {
      const halo = this.haloAt(rank);
      const first = this.cells[word.cells[0]].getBoundingClientRect();
      const last = this.cells[word.cells[word.cells.length - 1]].getBoundingClientRect();
      // Les dimensions sont posées avant l'affichage : une apparition ne doit
      // pas déclencher la transition de déplacement.
      halo.style.left = `${first.left - board.left - pad}px`;
      halo.style.top = `${first.top - board.top - pad}px`;
      halo.style.width = `${last.right - first.left + pad * 2}px`;
      halo.style.height = `${last.bottom - first.top + pad * 2}px`;
      halo.hidden = false;

      emprises.push({
        haut: first.top - board.top - pad,
        droite: last.right - board.left + pad,
      });
    });

    // Le score se pose au coin haut-droit de la bande la plus haute de
    // l'encadré — non du rectangle qui l'englobe. Sur une forme en L, ce
    // rectangle a un coin dans le vide, loin de toute tuile ; la bande la plus
    // haute, elle, est occupée par définition.
    const sommet = Math.min(...emprises.map((e) => e.haut));
    const bordDroit = Math.max(
      ...emprises.filter((e) => e.haut <= sommet + 1).map((e) => e.droite),
    );
    badge.style.left = `${bordDroit}px`;
    badge.style.top = `${sommet}px`;
    for (let rank = words.length; rank < this.halos.length; rank++) {
      this.halos[rank].hidden = true;
    }

    badge.hidden = false;
    if (verdict.score !== this.haloScore) {
      badge.textContent = String(verdict.score);
      if (!wasHidden) this.replay(badge, 'bump');
      this.haloScore = verdict.score;
    }
    return verdict;
  }

  /**
   * Le halo de rang donné, créé au besoin. Le rang 0 est celui du balisage,
   * qui porte la pastille de score ; les suivants cernent les mots croisés,
   * d'un trait plus discret pour ne pas noyer le plateau quand un coup en
   * forme plusieurs.
   */
  haloAt(rank) {
    while (this.halos.length <= rank) {
      const extra = document.createElement('div');
      extra.className = 'halo halo-crossing';
      extra.hidden = true;
      this.boardEl.append(extra);
      this.halos.push(extra);
    }
    return this.halos[rank];
  }

  hideHalos() {
    for (const halo of this.halos) halo.hidden = true;
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
    let repris = false;

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
        // Un joker est une tuile vierge : elle ne porte aucune lettre tant qu'on
        // ne l'a pas posé, et ne vaut rien. Le « ? » d'avant se lisait comme
        // une lettre, et sa valeur comme un score à faire.
        const joker = letter === BLANK;
        if (joker) tile.classList.add('blank');
        if (!joker) tile.append(document.createTextNode(letterChar(letter)));

        const value = document.createElement('span');
        value.className = 'value';
        value.textContent = String(joker ? 0 : VALUES[letter]);
        tile.append(value);

        shown.add(i);
        if ((this.forceRackPop || !this.rackShown.has(i)) && !reducedMotion.matches) {
          tile.classList.add('pop');
          tile.style.animationDelay = `${entering++ * 45}ms`;
        }

        // Un glissement en cours survit au rendu si la tuile qu'il tient est
        // toujours la même, à la même place : l'adversaire qui joue pendant
        // qu'on prépare son coup ne doit pas nous l'arracher des doigts.
        const drag = this.activeDrag;
        if (drag?.origin.from === 'rack' && drag.origin.rackIndex === i && drag.letter === letter) {
          drag.adopt(tile);
          repris = true;
        }

        this.attachTileDrag(tile, { from: 'rack', rackIndex: i });
        slot.append(tile);
      }
      rack.append(slot);
    }

    this.rackShown = shown;
    this.forceRackPop = false;

    // La tuile saisie n'a pas reparu — chevalet renouvelé, tuile posée
    // ailleurs : le glissement n'a plus d'objet et son fantôme doit partir.
    if (this.activeDrag?.origin.from === 'rack' && !repris) this.cancelDrag('rack');
  }

  /**
   * Bâtit une carte par joueur. Le sac se glisse entre les deux quand ils ne
   * sont que deux — c'est la disposition d'origine, et elle reste la plus
   * lisible ; à trois ou quatre il passe en bout de rangée, faute de milieu.
   */
  buildScoreCards() {
    const board = $('scoreboard');
    const bag = $('bag');
    bag.remove();
    board.textContent = '';

    this.scoreCards = this.game.players.map((player, seat) => {
      const card = document.createElement('div');
      card.className = 'score-card';
      card.dataset.seat = String(seat);

      // Seul l'adversaire calculé porte un bouton : lui seul mène quelque
      // part, le réglage du niveau.
      const name = document.createElement(player.isAI ? 'button' : 'span');
      name.className = player.isAI ? 'score-name level-chip' : 'score-name';
      if (player.isAI) {
        name.type = 'button';
        name.onclick = () => {
          if (this.mode === 'solo') $('rules-dialog').showModal();
        };
      }

      const value = document.createElement('span');
      value.className = 'score-value';
      value.textContent = String(player.score);

      card.append(name, value);
      board.append(card);
      return { card, name, value };
    });

    const middle = this.game.players.length === 2 ? board.children[1] : null;
    board.insertBefore(bag, middle);
    board.dataset.seats = String(this.game.players.length);

    this.shownScores = this.game.players.map((p) => p.score);
    this.scoreFrames = this.game.players.map(() => 0);
  }

  renderScores() {
    if (this.scoreCards?.length !== this.game.players.length) this.buildScoreCards();

    this.game.players.forEach((player, seat) => {
      const { card, name, value } = this.scoreCards[seat];

      if (player.isAI && this.mode === 'solo') {
        const difficulty = difficultyByLevel(this.level);
        // Contenu entièrement issu de nos constantes : pas de texte distant ici.
        name.innerHTML = `${levelIcon(difficulty.level)}<span>${difficulty.name}</span>`;
        name.disabled = false;
        name.title = `${difficulty.name}, niveau ${difficulty.level}. ${difficulty.blurb}`;
        name.setAttribute('aria-label', `Niveau ${difficulty.level}, ${difficulty.name}. Changer de niveau.`);
      } else {
        // Nom venu du réseau : jamais interprété comme du balisage.
        name.textContent = seat === HUMAN ? 'Vous' : player.name;
        if (player.isAI) name.disabled = true;
        name.removeAttribute('title');
        name.removeAttribute('aria-label');
      }

      this.updateScore(value, card, seat, player.score);
      card.classList.toggle('active', !this.game.finished && this.game.current === seat);
    });

    $('bag-count').textContent = String(this.game.bagCount);
  }

  /** Fait défiler un score jusqu'à sa nouvelle valeur. */
  updateScore(valueEl, cardEl, slot, target) {
    const from = this.shownScores[slot] ?? 0;
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
      who.textContent = this.seatName(entry.player);

      const what = document.createElement('span');
      what.className = 'what';
      if (entry.type === 'play') {
        what.textContent = entry.words.join(' · ');
        if (entry.bingo) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'scrabble';
          what.append(' ', tag);
        }
      } else if (entry.type === 'exchange') {
        what.className = 'what muted';
        what.textContent = `échange ${entry.count} tuile${entry.count > 1 ? 's' : ''}`;
      } else {
        what.className = 'what muted';
        what.textContent = 'passe';
      }

      const points = document.createElement('span');
      points.className = entry.score > 0 ? 'pts' : 'pts zero';
      points.textContent = entry.score > 0 ? `+${entry.score}` : '0';

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

    $('btn-recall').disabled = !hasPending;
    $('btn-shuffle').disabled = !this.canArrange();
    $('btn-hint').disabled = !myTurn;
    $('btn-more').disabled = !myTurn;
    $('btn-exchange-wide').disabled = !myTurn || this.game.bagCount === 0;
    $('btn-pass-wide').disabled = !myTurn;
    $('btn-resign-wide').disabled = this.game.finished;

    // Le halo et la pastille de score ne s'allument que sur un coup jouable :
    // le score annoncé est toujours un score réellement encaissable.
    const verdict = this.updateHalo();
    // Jouer n'est proposé que pour un coup valide, comme le halo.
    $('btn-play').disabled = !myTurn || !verdict?.ok;
    const preview = $('preview');
    if (verdict?.ok) {
      preview.hidden = false;
      preview.textContent = String(verdict.score);
    } else {
      preview.hidden = true;
    }

    this.renderStatus(verdict);
    this.renderNetChip();
  }

  renderStatus(verdict) {
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
      const n = this.marked.size;
      status.textContent = `${n} tuile${n > 1 ? 's' : ''} sélectionnée${n > 1 ? 's' : ''}.`;
      // En fin de sac, le plafond n'est plus théorique : on l'annonce avant
      // que le joueur ne coche une tuile de trop.
      if (this.game.bagCount < RACK_SIZE) {
        const reste = this.game.bagCount;
        status.textContent += ` Le sac n’en rendra que ${reste}.`;
        if (n > reste) status.classList.add('warn');
      }
      return;
    }
    if (this.mode !== 'solo' && !this.session?.connected) {
      status.classList.add('warn');
      status.textContent =
        this.mode === 'host'
          ? 'Liaison interrompue : plus personne à la table.'
          : 'Liaison interrompue avec la partie.';
      return;
    }
    if (this.game.current !== HUMAN) {
      const tour =
        this.mode === 'solo'
          ? 'Au tour de votre adversaire.'
          : `Au tour de ${this.seatName(this.game.current)}.`;
      status.textContent = this.pending.size > 0 ? `Coup préparé. ${tour}` : tour;
      return;
    }
    if (this.pending.size > 0) {
      // Jouer s'éteint sur un coup refusé : sans cette ligne, le refus serait
      // muet, le joueur n'ayant plus le bouton pour en réclamer la raison.
      if (verdict && !verdict.ok && !verdict.soft) {
        status.classList.add('warn');
        status.textContent = verdict.reason;
        return;
      }
      status.textContent = 'Validez votre mot ou reprenez vos tuiles.';
      return;
    }
    status.textContent =
      this.game.history.length === 0
        ? 'Posez votre premier mot sur la case centrale.'
        : 'À vous de jouer.';
  }

  /** Nom d'un siège tel que ce joueur-ci doit le lire. */
  seatName(seat) {
    if (seat === HUMAN) return 'Vous';
    return this.game.players[seat]?.name ?? 'Adversaire';
  }

  endSentence() {
    if (this.game.winner === null) return 'Égalité parfaite.';
    if (this.game.winner === HUMAN) return 'Vous gagnez !';
    return `${this.seatName(this.game.winner)} l’emporte.`;
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

  /**
   * Manipuler ses tuiles ne dépend pas du tour : on prépare son coup pendant
   * que l'adversaire réfléchit, comme on avance une pièce en pensée aux
   * échecs. Seul l'envoi du coup reste réservé à son tour.
   */
  canArrange() {
    return !this.game.finished;
  }

  /**
   * Retire les poses préparées que le plateau a rattrapées : l'adversaire a
   * pu jouer sur une case qu'on se réservait. Les tuiles retournent au
   * chevalet, leur référence n'étant plus tenue par personne.
   * @returns {number} nombre de poses reprises
   */
  prunePending() {
    let reprises = 0;
    for (const index of [...this.pending.keys()]) {
      if (this.game.board.letters[index] >= 0) {
        this.pending.delete(index);
        reprises++;
      }
    }
    if (reprises > 0) {
      this.cursor = null;
      this.toast(
        reprises === 1
          ? 'Une lettre préparée est revenue : sa case a été prise.'
          : `${reprises} lettres préparées sont revenues : leurs cases ont été prises.`,
      );
    }
    return reprises;
  }

  onCellTap(index) {
    if (!this.canArrange()) return;
    if (this.exchangeMode) return;

    if (this.pending.has(index)) {
      this.pending.delete(index);
      this.cursor = { index, direction: this.cursor?.direction ?? 0 };
      this.ouvrirClavierTactile();
      this.refresh();
      return;
    }

    if (this.game.board.letters[index] >= 0) return;

    if (this.selected !== null) {
      this.placeTile(index, this.selected);
      return;
    }

    // Sans tuile sélectionnée, la case devient le point de saisie clavier, et
    // sur un appareil tactile c'est ce geste qui fait monter le clavier. Le
    // focus doit être pris ici même : hors du geste, le navigateur le refuse.
    const sameCell = this.cursor?.index === index;
    this.cursor = { index, direction: sameCell ? 1 - this.cursor.direction : 0 };
    this.ouvrirClavierTactile();
    this.refresh();
  }

  /**
   * Pose une tuile du chevalet sur une case.
   *
   * @param {number} index case visée
   * @param {number} rackIndex tuile du chevalet
   * @param {{advance?: boolean}} [options] `advance` fait glisser le point de
   *   saisie clavier sur la case suivante. Réservé à la frappe : après une
   *   pose à la souris ou au doigt, rien n'indique où ira la lettre d'après.
   */
  async placeTile(index, rackIndex, { advance = false } = {}) {
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
    this.cursor = advance
      ? { index: this.nextCell(index), direction: this.cursor?.direction ?? 0 }
      : null;
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
    // Le clavier virtuel occupe le bas de l'écran, c'est-à-dire exactement la
    // place du chevalet : dès qu'on y touche, il doit redescendre.
    this.fermerClavierTactile();
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
   * Rend une tuile déplaçable à la souris comme au doigt.
   *
   * @param {HTMLElement} element
   * @param {{from: 'rack', rackIndex: number}|{from: 'board', index: number}} origin
   */
  attachTileDrag(element, origin) {
    let ghost = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    /** Vrai dès qu'un rendu a emporté la tuile : le glissement n'aboutira pas. */
    let annule = false;

    /**
     * Efface les traces visibles du glissement, sans toucher aux écouteurs.
     *
     * Ceux-ci vivent sur la fenêtre et non sur la tuile, et survivent à
     * l'annulation : une tuile peut disparaître en plein glissement — tout
     * rendu reconstruit le chevalet — et des écouteurs posés sur elle
     * partiraient avec. Le relâchement ne serait jamais reçu, le fantôme
     * resterait collé à l'écran et l'original reparaîtrait dans sa case, en
     * double sous le doigt. On les garde donc jusqu'au vrai relâchement, qui
     * seul sait à quel instant poser le jalon anti-clic.
     */
    const effacer = () => {
      // `element` a pu être remplacé par un rendu : on retire la classe de la
      // tuile qui la porte réellement.
      (this.activeDrag?.element ?? element).classList.remove('dragging');
      ghost?.remove();
      ghost = null;
      this.clearDropHighlight();
      if (this.activeDrag?.stop === stop) this.activeDrag = null;
    };

    /** Abandon demandé de l'extérieur, par un rendu. */
    const stop = () => {
      annule = true;
      effacer();
    };

    const onMove = (event) => {
      if (annule) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 8) return;

      if (!dragging) {
        dragging = true;
        const box = element.getBoundingClientRect();

        // La tuile suivi par le pointeur est la tuile elle-même, clonée avec
        // ses classes : elle doit être identique à celle qu'on a saisie. Le
        // clone est pris avant « dragging », qui rend l'original invisible.
        const face = element.cloneNode(true);
        // Les tailles de la tuile sont en « cqw », résolues contre le plateau
        // ou le chevalet que le fantôme quitte. Tout en dérive par `em` : il
        // suffit de figer la taille de police pour que le reste suive.
        face.style.fontSize = getComputedStyle(element).fontSize;

        // L'enveloppe porte la position et la taille ; la tuile s'y tend par
        // `inset: 0`, comme dans sa case d'origine. Les marges internes de la
        // tuile sont en pourcentage : il leur faut ce bloc conteneur à la
        // bonne taille, sans quoi elles se résolvent contre la fenêtre et
        // chassent la lettre dans le coin.
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.style.width = `${box.width}px`;
        ghost.style.height = `${box.height}px`;
        ghost.append(face);
        document.body.append(ghost);

        element.classList.add('dragging');
        // Un rendu survenant maintenant doit pouvoir soit reprendre ce
        // glissement à son compte, soit l'abandonner proprement. La lettre est
        // retenue pour vérifier, au rendu suivant, que c'est bien la même
        // tuile qui occupe la place.
        this.activeDrag = {
          stop,
          element,
          origin,
          letter: origin.from === 'rack' ? this.game.players[HUMAN].rack[origin.rackIndex] : null,
          adopt: (tile) => {
            this.activeDrag.element = tile;
            tile.classList.add('dragging');
          },
        };
      }
      ghost.style.left = `${event.clientX}px`;
      ghost.style.top = `${event.clientY}px`;
      this.highlightDrop(origin, event.clientX, event.clientY);
    };

    const onUp = (event) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);

      const glissait = dragging;
      const abandonne = annule;
      effacer();

      // Un glissement, même abandonné en route, produit un clic au
      // relâchement. Sans ce jalon, le plateau le prendrait pour un appui sur
      // la case et reprendrait la tuile qu'on venait d'y poser.
      if (glissait) this.dragEndedAt = performance.now();

      if (abandonne) return;

      if (!glissait) {
        // Simple appui. Sur le chevalet il vaut sélection ; sur le plateau
        // c'est le gestionnaire de clic du plateau qui s'en charge.
        if (origin.from === 'rack') this.selectRackTile(origin.rackIndex);
        return;
      }

      this.dropTile(origin, event.clientX, event.clientY);
    };

    element.addEventListener('pointerdown', (event) => {
      if (!this.canArrange()) return;
      // Un glissement déjà en cours n'a pas de raison de survivre au suivant.
      this.cancelDrag();
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* pointeur déjà relâché : le suivi reste correct sans capture */
      }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  /**
   * Abandonne le glissement en cours, s'il y en a un.
   *
   * Appelé avant chaque rendu : la tuile saisie est sur le point d'être
   * détruite, et son fantôme n'aurait plus de quoi se raccrocher. Le coup
   * n'est pas joué — on préfère perdre un geste que poser une tuile au
   * hasard sur un chevalet qui vient de changer sous les doigts.
   */
  cancelDrag(kind) {
    if (!this.activeDrag) return;
    if (kind && this.activeDrag.origin.from !== kind) return;
    this.activeDrag.stop();
  }

  /**
   * Signale la destination survolée : case accueillante, case refusée, ou
   * chevalet lorsqu'on ramène une tuile déjà posée.
   */
  highlightDrop(origin, x, y) {
    const under = document.elementFromPoint(x, y);
    const cell = under?.closest('.cell') ?? null;

    if (cell !== this.dropCell) {
      this.dropCell?.classList.remove('drop-target', 'drop-swap', 'drop-blocked');
      this.dropCell = cell;
    }

    let swapping = false;
    if (cell) {
      const index = Number(cell.dataset.index);
      const { free, swap } = this.dropKind(origin, index);
      swapping = swap;
      cell.classList.toggle('drop-target', free);
      cell.classList.toggle('drop-swap', swap);
      cell.classList.toggle('drop-blocked', !free && !swap);
    }

    // La tuile suivi par le pointeur recouvre la case qu'il survole, et le
    // doigt par-dessus : un jalon posé là ne se verrait pas. C'est donc la
    // place libérée, à l'autre bout de l'échange, qui s'allume.
    const source = swapping ? this.dragOriginElement(origin) : null;
    if (source !== this.dropSource) {
      this.dropSource?.classList.remove('drop-swap-origin');
      source?.classList.add('drop-swap-origin');
      this.dropSource = source;
    }
  }

  /** La case ou l'emplacement de chevalet d'où part la tuile déplacée. */
  dragOriginElement(origin) {
    return origin.from === 'board'
      ? this.cells[origin.index] ?? null
      : $('rack').children[origin.rackIndex] ?? null;
  }

  /**
   * Ce que vaut un lâcher sur une case donnée.
   *
   * `free` : la case est vide, la tuile s'y pose. La case de départ d'un
   * tuile déplacée en fait partie — l'y reposer doit rester sans effet.
   *
   * `swap` : la case porte une pose en attente, que la tuile lâché prend en
   * remplaçant. Les deux échangent alors leur place, l'autre repartant vers
   * le plateau ou vers le chevalet selon d'où vient celui qu'on tient. Un
   * tuile déjà validée, elle, n'est plus déplaçable : la case reste refusée.
   */
  dropKind(origin, index) {
    if (index === origin.index) return { free: true, swap: false };
    if (this.game.board.letters[index] >= 0) return { free: false, swap: false };
    return { free: !this.pending.has(index), swap: this.pending.has(index) };
  }

  clearDropHighlight() {
    this.dropCell?.classList.remove('drop-target', 'drop-swap', 'drop-blocked');
    this.dropCell = null;
    this.dropSource?.classList.remove('drop-swap-origin');
    this.dropSource = null;
  }

  /** Applique le lâcher d'une tuile à la position du pointeur. */
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
      const { free, swap } = this.dropKind(origin, index);

      if (origin.from === 'rack') {
        if (free || swap) {
          // Sur une case occupée, poser écrase la pose en attente : sa tuile
          // n'est plus référencé, et le chevalet le reprend de lui-même.
          this.placeTile(index, origin.rackIndex);
          this.sons.jouer('pose');
          return;
        }
      } else if (index === origin.index) {
        this.refresh(); // reposé sur sa propre case
        return;
      } else if (free) {
        // Déplacement d'une tuile déjà posée, sans repasser par le chevalet.
        const tile = this.pending.get(origin.index);
        this.pending.delete(origin.index);
        this.pending.set(index, tile);
        this.cursor = null;
        this.sons.jouer('pose');
        this.refresh();
        return;
      } else if (swap) {
        // Deux poses en attente échangent leur case.
        const moved = this.pending.get(origin.index);
        this.pending.set(origin.index, this.pending.get(index));
        this.pending.set(index, moved);
        this.cursor = null;
        this.sons.jouer('pose');
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
   * du chevalet, même quand des tuiles sont posés sur le plateau.
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
   * Déplace une tuile du chevalet à une autre position.
   *
   * Les poses en attente référencent leur tuile par son index de chevalet :
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

    // Position de départ de chaque tuile, relevée avant le remaniement : elle
    // sert à les faire glisser jusqu'à leur nouvelle place plutôt que de les
    // y téléporter.
    const departs = new Map();
    for (const tile of $('rack').querySelectorAll('.rack-tile')) {
      departs.set(Number(tile.dataset.rackIndex), tile.getBoundingClientRect().left);
    }

    const order = rack.map((_, i) => i);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);

    const remap = new Map();
    order.forEach((oldIndex, newIndex) => remap.set(oldIndex, newIndex));
    const provenance = new Map();
    remap.forEach((newIndex, oldIndex) => provenance.set(newIndex, oldIndex));

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
    this.slideRackTiles(departs, provenance, to);
  }

  /**
   * Fait glisser les tuiles du chevalet de leur ancienne position vers la
   * nouvelle. Le rendu vient de les recréer : on les anime depuis l'écart
   * mesuré, ce qui donne le mouvement sans dupliquer la mise en page.
   *
   * La tuile déplacée en est exclue : elle vient d'être lâchée à destination, le
   * faire repartir de son ancienne place donnerait un aller-retour.
   *
   * @param {Map<number, number>} departs ancien index → abscisse d'origine
   * @param {Map<number, number>} provenance nouvel index → ancien index
   * @param {number} deplace nouvel index de la tuile que l'on vient de lâcher
   */
  slideRackTiles(departs, provenance, deplace) {
    if (reducedMotion.matches) return;

    for (const tile of $('rack').querySelectorAll('.rack-tile')) {
      const index = Number(tile.dataset.rackIndex);
      if (index === deplace) continue;

      const depart = departs.get(provenance.get(index));
      if (depart === undefined) continue;

      const ecart = depart - tile.getBoundingClientRect().left;
      if (Math.abs(ecart) < 1) continue;

      tile.animate(
        [{ transform: `translateX(${ecart}px)` }, { transform: 'translateX(0)' }],
        { duration: 220, easing: 'cubic-bezier(0.2, 0.85, 0.3, 1)' },
      );
    }
  }

  askBlankLetter() {
    const dialog = $('blank-dialog');
    return new Promise((resolve) => {
      const finish = (value) => {
        this.resolveBlank = null;
        dialog.close();
        resolve(value);
      };
      this.resolveBlank = finish;
      $('blank-cancel').onclick = () => finish(null);
      dialog.onclose = () => this.resolveBlank && finish(null);

      // La fenêtre s'ouvre à la frame suivante. Ouverte au milieu du geste qui
      // vient de lâcher la tuile, elle reçoit le clic que le téléphone
      // synthétise derrière le toucher, et le premier appui se perd.
      requestAnimationFrame(() => dialog.showModal());
    });
  }

  /**
   * Case voisine dans une direction donnée, en sautant celles qui sont déjà
   * occupées. Rend -1 si on sort du plateau ou de la ligne.
   *
   * @param {number} index case de départ
   * @param {number} pas `1` ou `-1` horizontalement, `SIZE` ou `-SIZE`
   *   verticalement
   * @param {boolean} sauterOccupees au clavier on enjambe les lettres déjà
   *   posées, parce qu'on ne peut rien en faire ; les flèches, elles, servent
   *   aussi à se promener, et s'arrêtent où on les envoie.
   */
  caseVoisine(index, pas, sauterOccupees = true) {
    const horizontal = Math.abs(pas) === 1;
    const ligne = Math.floor(index / SIZE);
    let suivante = index + pas;
    while (suivante >= 0 && suivante < CELLS) {
      // Une case à gauche de la première colonne tombe à la fin de la ligne
      // précédente : c'est le même nombre, et ce n'est pas la même case.
      if (horizontal && Math.floor(suivante / SIZE) !== ligne) return -1;
      if (!sauterOccupees) return suivante;
      if (this.game.board.letters[suivante] < 0) return suivante;
      suivante += pas;
    }
    return -1;
  }

  /** Point de saisie de départ : le centre s'il est libre, sinon la première
   *  case libre du plateau. On ne peut pas taper sans point d'entrée, et
   *  demander un clic avant la première touche serait une porte fermée. */
  premierPointDeSaisie() {
    const centre = Math.floor(CELLS / 2);
    if (this.game.board.letters[centre] < 0 && !this.pending.has(centre)) return centre;
    for (let i = 0; i < CELLS; i++) {
      if (this.game.board.letters[i] < 0 && !this.pending.has(i)) return i;
    }
    return -1;
  }

  /**
   * Déplace le point de saisie à la flèche, sans toucher au sens d'écriture.
   * Les deux choses sont séparées exprès : on se déplace sur le plateau bien
   * plus souvent qu'on ne change de sens, et une flèche qui réoriente la
   * saisie retourne le mot en cours sans qu'on l'ait demandé. Le sens est à
   * la barre d'espace, et à elle seule.
   */
  deplacerCurseur(dx, dy) {
    const direction = this.cursor?.direction ?? 0;
    if (!this.cursor || this.cursor.index < 0) {
      const depart = this.premierPointDeSaisie();
      if (depart < 0) return;
      this.cursor = { index: depart, direction };
      this.refresh();
      return;
    }
    const vise = this.caseVoisine(this.cursor.index, dx !== 0 ? dx : dy * SIZE, false);
    if (vise < 0) return;
    this.cursor = { index: vise, direction };
    this.refresh();
  }

  /** Retire la tuile préparée d'une case, s'il y en a une. */
  reprendrePreparee(index) {
    if (index < 0 || !this.pending.has(index)) return false;
    this.pending.delete(index);
    return true;
  }

  /**
   * Pose la lettre d'un caractère tapé sur le point de saisie, puis avance.
   *
   * Partagé par les deux claviers, qui ne parlent pas la même langue : celui
   * d'un ordinateur envoie des touches, celui d'un téléphone envoie du texte.
   * Tout ce qui est commun aux deux est ici.
   *
   * @param {string} caractere une seule lettre, accentuée ou non
   * @param {boolean} [joker] exiger le joker même si la vraie lettre est en main
   * @returns {boolean} vrai si la lettre a été posée
   */
  taperLettre(caractere, joker = false) {
    if (!/^[a-zA-Zà-ÿ]$/.test(caractere)) return false;
    const voulue = caractere
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .charCodeAt(0) - 65;
    if (voulue < 0 || voulue > 25) return false;

    // Taper sans avoir désigné de case doit marcher : on ouvre la saisie au
    // centre plutôt que d'ignorer la touche.
    if (!this.cursor || this.cursor.index < 0) {
      const depart = this.premierPointDeSaisie();
      if (depart < 0) return false;
      this.cursor = { index: depart, direction: 0 };
    }

    const { index: cible, direction } = this.cursor;
    const rack = this.game.players[HUMAN].rack;
    // La tuile déjà préparée sur la case visée ne compte pas comme prise :
    // on va la reprendre. Sans cette exception, retaper par-dessus la seule
    // copie d'une lettre échouait, puisqu'elle se voyait elle-même en main.
    const prises = new Set(
      [...this.pending.entries()].filter(([i]) => i !== cible).map(([, p]) => p.rackIndex),
    );
    let index = joker ? -1 : rack.findIndex((l, i) => l === voulue && !prises.has(i));
    if (index < 0) index = rack.findIndex((l, i) => l === BLANK && !prises.has(i));
    if (index < 0) return false;

    // Écraser une case déjà préparée plutôt que de refuser la frappe : on se
    // corrige en retapant, pas en effaçant d'abord.
    this.reprendrePreparee(cible);
    if (rack[index] === BLANK) {
      this.pending.set(cible, { letter: voulue, blank: true, rackIndex: index });
      this.cursor = { index: this.nextCell(cible), direction };
      this.refresh();
    } else {
      this.placeTile(cible, index, { advance: true });
    }
    return true;
  }

  /**
   * Effacement arrière : on revient sur ses pas, comme dans un champ de texte.
   * La case précédente le long de la direction d'écriture perd sa tuile et
   * reçoit le point de saisie. Si elle est vide, on s'y place quand même —
   * on recule, c'est ce qu'on attend de cette touche.
   */
  effacerArriere() {
    const direction = this.cursor?.direction ?? 0;
    if (!this.cursor || this.cursor.index < 0) {
      const dernier = [...this.pending.keys()].pop();
      if (dernier === undefined) return false;
      this.pending.delete(dernier);
      this.cursor = { index: dernier, direction };
      this.refresh();
      return true;
    }
    if (this.reprendrePreparee(this.cursor.index)) {
      this.refresh();
      return true;
    }
    const precedente = this.caseVoisine(this.cursor.index, direction === 0 ? -1 : -SIZE, false);
    if (precedente < 0) return false;
    this.reprendrePreparee(precedente);
    this.cursor = { index: precedente, direction };
    this.refresh();
    return true;
  }

  /** Suppression avant : on vide la case où l'on est, sans bouger. */
  supprimerSurPlace() {
    if (!this.cursor || !this.reprendrePreparee(this.cursor.index)) return false;
    this.refresh();
    return true;
  }

  /** Bascule entre écrire en ligne et écrire en colonne. */
  tournerSaisie() {
    if (!this.cursor || this.cursor.index < 0) {
      const depart = this.premierPointDeSaisie();
      if (depart < 0) return false;
      this.cursor = { index: depart, direction: 0 };
    } else {
      this.cursor = { index: this.cursor.index, direction: 1 - this.cursor.direction };
    }
    this.refresh();
    return true;
  }

  bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (event.target.closest('dialog')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!this.canArrange()) return;

      // Quand un élément a le focus, les touches de navigation et
      // d'activation lui appartiennent : voler Tab, c'est supprimer la
      // navigation au clavier, et voler Espace, c'est empêcher d'appuyer sur
      // le bouton qu'on vient d'atteindre. Les lettres, elles, n'intéressent
      // personne d'autre que le plateau — sauf dans un champ de texte, où
      // elles sont évidemment pour lui.
      //
      // Le champ de saisie tactile est l'exception : il ne sert qu'à faire
      // monter le clavier du téléphone, et tout ce qu'il reçoit est pour le
      // plateau. Sans cette exception, un ordinateur dont ce champ a pris le
      // focus n'aurait plus de frappe du tout.
      const controle = event.target.closest('button, a[href], select, input, textarea, [contenteditable]');
      if (controle && controle !== this.champSaisie) {
        if (controle.matches('input, textarea, [contenteditable]')) return;
        if (['Tab', ' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      }

      const fleches = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (fleches[event.key]) {
        event.preventDefault();
        this.deplacerCurseur(...fleches[event.key]);
        return;
      }

      // Espace seulement, pas Tab : Tab doit rester la touche qui change de
      // bouton, sinon on enferme au clavier ceux qui n'ont que lui.
      if (event.key === ' ') {
        if (this.tournerSaisie()) event.preventDefault();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        this.commitPlay();
        return;
      }

      if (event.key === 'Escape') {
        if (this.pending.size > 0) this.recall();
        else if (this.cursor) {
          this.cursor = null;
          this.refresh();
        }
        return;
      }

      if (event.key === 'Backspace') {
        event.preventDefault();
        this.effacerArriere();
        return;
      }

      if (event.key === 'Delete') {
        event.preventDefault();
        this.supprimerSurPlace();
        return;
      }

      // Majuscule : on exige le joker. C'est la convention des notations de
      // Scrabble, et le seul moyen d'imposer le joker quand on a aussi la
      // vraie lettre en main.
      if (this.taperLettre(event.key, event.shiftKey)) event.preventDefault();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Frappe au téléphone                                               */
  /* ---------------------------------------------------------------- */

  /**
   * La frappe sur un appareil tactile.
   *
   * Trois choses la distinguent de celle d'un ordinateur, et chacune a sa
   * conséquence dans ce qui suit.
   *
   * Un clavier virtuel ne s'ouvre que pour un champ qui a le focus : il faut
   * donc un champ, et le focus doit être pris pendant le geste de
   * l'utilisateur, car hors d'un appui le navigateur le refuse.
   *
   * Ce clavier n'envoie pas des touches mais du texte : sur Android, `keydown`
   * arrive souvent sans nom de touche exploitable. On écoute donc
   * `beforeinput`, qui dit à la fois ce qui est inséré et ce qui est effacé.
   *
   * Enfin, un effacement arrière dans un champ vide ne produit rien du tout.
   * Le champ garde donc en permanence un caractère, qu'on remet après chaque
   * événement : il y a toujours quelque chose à effacer, donc l'événement
   * arrive toujours.
   */
  bindSaisieTactile() {
    const champ = $('saisie-tactile');
    if (!champ) return;
    this.champSaisie = champ;

    const SENTINELLE = '\u00a0';
    const remettre = () => {
      champ.value = SENTINELLE;
      try {
        champ.setSelectionRange(1, 1);
      } catch {
        // Certains navigateurs refusent sur un champ sans focus : sans
        // importance, le caractère est en place et c'est lui qui compte.
      }
    };
    remettre();

    champ.addEventListener('beforeinput', (event) => {
      if (!this.canArrange()) return;
      event.preventDefault();
      remettre();
      const type = event.inputType;
      if (type.startsWith('delete')) {
        this.effacerArriere();
      } else if (type === 'insertLineBreak' || type === 'insertParagraph') {
        this.commitPlay();
      } else {
        for (const c of event.data ?? '') this.taperLettre(c);
      }
    });

    // Filet : si un clavier passe outre le refus et écrit quand même, on
    // rattrape ce qui a été posé dans le champ puis on le remet à neuf.
    champ.addEventListener('input', () => {
      const ecrit = champ.value.split(SENTINELLE).join('');
      remettre();
      if (!this.canArrange()) return;
      for (const c of ecrit) this.taperLettre(c);
    });
  }

  /**
   * Fait monter le clavier du téléphone. À n'appeler que depuis le geste de
   * l'utilisateur : ailleurs, le navigateur refuse de donner le focus.
   */
  ouvrirClavierTactile() {
    if (!this.champSaisie) return;
    // Seulement là où il n'y a pas déjà un vrai clavier. Sur un ordinateur,
    // prendre le focus ne ferait que le retirer à ce qui l'avait.
    if (!window.matchMedia('(any-pointer: coarse)').matches) return;
    this.champSaisie.focus({ preventScroll: true });
  }

  /** Referme le clavier du téléphone. */
  fermerClavierTactile() {
    if (this.champSaisie && document.activeElement === this.champSaisie) this.champSaisie.blur();
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  bindActions() {
    $('btn-play').onclick = () => this.commitPlay();
    $('btn-recall').onclick = () => this.recall();
    $('btn-shuffle').onclick = () => this.shuffleRack();
    $('btn-hint').onclick = () => this.askHint();

    const boutonSon = $('btn-sound');
    const majSon = () => {
      boutonSon.setAttribute('aria-pressed', String(this.sons.actifs));
      boutonSon.setAttribute('aria-label', this.sons.actifs ? 'Couper le son' : 'Rétablir le son');
    };
    majSon();
    boutonSon.onclick = () => {
      this.sons.actifs = !this.sons.actifs;
      majSon();
      try {
        localStorage.setItem(SON_KEY, this.sons.actifs ? 'on' : 'off');
      } catch {
        /* le réglage vaudra pour cette session seulement */
      }
      // Un aperçu immédiat : rallumer sans rien entendre laisse dans le doute.
      if (this.sons.actifs) this.sons.jouer('pose');
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

    // Le plateau et le chevalet d'*avant* le coup : `play()` va les modifier,
    // et c'est sur la position de départ que se juge l'optimalité.
    const depart = {
      board: { letters: [...this.game.board.letters], blanks: [...this.game.board.blanks] },
      rack: [...this.game.players[HUMAN].rack],
      placements: this.placements(),
      bagCount: this.game.bagCount,
    };

    if (this.mode === 'guest') {
      // L'invité ne fait pas autorité : il vérifie pour lui-même, puis laisse
      // l'hôte arbitrer et lui renvoyer l'état.
      const verdict = validateMove(this.game.board, this.placements(), this.dawg);
      if (!verdict.ok) {
        this.toast(verdict.reason, 'error');
        this.sons.jouer('refus');
        return;
      }
      this.sendIntent({ t: 'play', placements: this.placements() });
      // L'hôte applique le même dictionnaire et la même validation : un coup
      // que l'invité accepte ne sera pas refusé là-bas.
      this.jugerOptimalite(depart, verdict.score, verdict.bingo);
      return;
    }

    const result = this.game.play(this.placements(), this.dawg);
    if (!result.ok) {
      this.toast(result.reason, 'error');
      this.sons.jouer('refus');
      return;
    }

    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.revealCells = [...this.game.lastMoveCells];
    this.revealKind = 'settle';

    const words = result.words.map((w) => w.word).join(', ');
    this.toast(
      result.bingo ? `Scrabble ! ${words} +${result.score}` : `${words} +${result.score}`,
      'good',
    );
    this.sons.jouer(result.bingo ? 'scrabble' : 'coup');
    if (result.bingo) this.replay(this.boardEl, 'bingo');
    this.jugerOptimalite(depart, result.score, result.bingo);

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
    if (this.game.bagCount === 0) {
      this.toast('Le sac est vide : plus rien à échanger.', 'error');
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
      this.toast('Choisissez au moins une tuile.', 'error');
      return;
    }
    // On ne rend jamais plus qu'on ne peut repiocher : le chevalet doit
    // revenir à sept.
    if (this.marked.size > this.game.bagCount) {
      const n = this.game.bagCount;
      this.toast(`Le sac ne contient que ${n} tuile${n > 1 ? 's' : ''}.`, 'error');
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
    this.toast(`${tiles.length} tuile${tiles.length > 1 ? 's' : ''} échangée${tiles.length > 1 ? 's' : ''}.`);
    this.sons.jouer('echange');
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
    if (this.mode === 'host') {
      // L'hôte abandonne comme les autres : la partie revient au meilleur
      // des joueurs restants.
      this.endByResignation(HUMAN);
      return;
    }
    this.game.finished = true;
    this.game.winner = COMPUTER;
    this.game.endReason = 'Vous avez abandonné la partie.';
    this.save();
    this.render();
    this.showEnd();
  }

  newGame() {
    if (this.mode === 'host') {
      this.startNetworkGame();
      return;
    }
    if (this.mode === 'guest') {
      // Seul l'hôte rebat les cartes : à quatre, une revanche lancée par un
      // invité prendrait les trois autres de court.
      this.session?.send({ t: 'rematch' });
      this.toast('Revanche demandée à l’hôte.');
      return;
    }
    this.game = new Game({ level: this.level });
    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.cancelExchange();
    this.save();
    this.render();
    this.toast('Nouvelle partie. À vous de jouer.');
  }

  /**
   * Cherche s'il reste un coup jouable, et passe le tour s'il n'y en a pas.
   *
   * Sans cela, un chevalet bloqué — sept consonnes en fin de partie, un
   * plateau fermé — oblige à chercher longtemps pour ne rien trouver, puis à
   * passer soi-même. L'énumération est celle de l'indice : c'est exactement
   * la même question, « existe-t-il un coup ? », et elle part dans le worker
   * pour ne pas figer l'écran.
   *
   * Ne se déclenche qu'au début d'un tour intact : un coup en préparation,
   * un échange en cours ou un tour déjà joué ne sont pas des blocages.
   */
  verifierBlocage() {
    if (this.game.finished || this.busy) return;
    if (this.game.current !== HUMAN) return;
    if (this.pending.size > 0 || this.exchangeMode) return;
    if (this.mode !== 'solo' && !this.session?.connected) return;
    if (this.blocageEnCours) return;

    this.blocageEnCours = true;
    const id = ++this.requestId;
    this.pendingRequests.set(id, 'blocage');
    this.worker.postMessage({
      type: 'hint',
      id,
      board: { letters: [...this.game.board.letters], blanks: [...this.game.board.blanks] },
      rack: [...this.game.players[HUMAN].rack],
    });
  }

  /**
   * Verdict du moteur sur un chevalet bloqué.
   *
   * Le tour a pu changer entre-temps — l'adversaire joue vite en ligne — donc
   * on revérifie tout avant de passer quoi que ce soit.
   */
  async surBlocage(move) {
    this.blocageEnCours = false;
    if (move) return;
    if (this.game.finished || this.busy) return;
    if (this.game.current !== HUMAN) return;
    if (this.pending.size > 0 || this.exchangeMode) return;

    // Tant qu'il reste une tuile au fond du sac, échanger vaut mieux que
    // passer : on le dit et on laisse la main. Passer d'office priverait le
    // joueur du seul coup qui lui restait.
    if (this.game.bagCount > 0) {
      this.toast('Aucun coup possible. Échangez des tuiles.');
      this.sons.jouer('refus');
      return;
    }

    this.toast('Aucun coup possible et sac vide. Tour passé.');
    this.sons.jouer('refus');
    await new Promise((r) => setTimeout(r, BLOCAGE_MS));

    // Une dernière fois : le tour a pu changer pendant ce délai.
    if (this.game.finished || this.busy) return;
    if (this.game.current !== HUMAN) return;
    if (this.pending.size > 0 || this.exchangeMode) return;
    this.passTurn();
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
    if (this.mode === 'solo' && this.game.current === COMPUTER) {
      this.runComputerTurn();
      return;
    }
    // En ligne, l'hôte peut reprendre la main dès qu'un invité a joué.
    this.verifierBlocage();
  }

  /**
   * Demande au moteur ce que valait le coup qu'on vient de jouer, et félicite
   * le cas échéant.
   *
   * Le calcul est le même que celui de l'indice — l'énumération complète des
   * coups légaux — donc il part dans le worker. Il ne touche pas à `busy` :
   * c'est une vérification d'arrière-plan, elle ne doit rien bloquer.
   *
   * Le coup joué part avec la demande : c'est le worker qui le mesure, avec le
   * même barème que les autres. Comparer ici une valeur calculée là-bas
   * reviendrait à comparer deux échelles différentes.
   */
  jugerOptimalite(depart, score, bingo) {
    const id = ++this.requestId;
    this.pendingRequests.set(id, 'best');
    this.attenteOptimalite = { id, score };
    this.worker.postMessage({
      type: 'best',
      id,
      board: depart.board,
      rack: depart.rack,
      bagCount: depart.bagCount,
      played: { score, bingo: Boolean(bingo), placements: depart.placements },
    });
  }

  /** Salue un coup optimal. */
  feliciter(texte = FELICITATION, variante = '') {
    this.toast(texte, `best ${variante}`.trim());
    this.sons.jouer('optimal');
    this.etinceler();
    // L'adversaire enchaîne aussitôt et son propre message chasserait
    // celui-ci : on lui demande de patienter le temps qu'on le lise.
    this.felicitationJusqua = performance.now() + FELICITATION_MS;
  }

  /**
   * Allume les tuiles du coup salué, l'une après l'autre.
   *
   * La félicitation arrive après le rendu du coup : les tuiles sont donc en
   * place et stables. La classe disparaît d'elle-même au rendu suivant, celui
   * du coup de l'adversaire.
   */
  etinceler() {
    if (reducedMotion.matches) return;
    (this.game.lastMoveCells ?? []).forEach((index, i) => {
      const tile = this.boardEl?.querySelector(`[data-index="${index}"] .tile`);
      if (!tile) return;
      tile.style.setProperty('--etincelle-delai', `${i * ETINCELLE_PAS_MS}ms`);
      tile.classList.add('etincelle');
    });
  }

  runComputerTurn() {
    this.busy = true;
    document.querySelector('.thinking-label').textContent =
      `${this.game.players[COMPUTER].name} réfléchit`;
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

    if (message.type === 'best') {
      const attente = this.attenteOptimalite;
      this.attenteOptimalite = null;
      if (attente?.id === message.id && message.count >= MIN_COUPS_POUR_FELICITER) {
        // Deux façons de bien jouer, deux félicitations, et une hiérarchie :
        // le coup du Centurion passe devant, y compris quand il est aussi le
        // plus gros score — ce qui arrive souvent, un scrabble étant presque
        // toujours les deux à la fois. C'est la distinction la plus haute,
        // elle ne doit pas se faire coiffer par l'autre.
        //
        // « Meilleur coup ! » ne salue donc plus que le cas restant : le
        // maximum de points, alors qu'un meilleur jeu existait.
        if (message.playedValue >= message.bestValue - EGALITE_STRATEGIQUE) {
          this.feliciter(FELICITATION_STRATEGIQUE, 'strategique');
        } else if (attente.score >= message.score) this.feliciter();
      }
      return;
    }

    if (message.type === 'hint') {
      // Même calcul que l'indice, mais demandé par le jeu et non par le
      // joueur : il ne touche pas à `busy` et n'annonce rien s'il trouve.
      if (kind === 'blocage') {
        this.surBlocage(message.move);
        return;
      }

      this.busy = false;
      const move = message.move;
      if (!move) this.toast('Aucun coup possible avec ce chevalet.', 'error');
      else {
        // Le mot annoncé est celui que le joueur doit composer, c'est-à-dire
        // celui qui compte le plus de lettres à poser — et non le plus long.
        // Un coup qui ajoute un S à un mot déjà sur le plateau forme un mot
        // plus long que celui qu'on pose : l'indice envoyait alors « terminer »
        // un mot déjà écrit, en taisant les sept lettres du vrai coup.
        const posees = new Set(move.placements.map((p) => p.row * SIZE + p.col));
        const aPoser = (word) => word.cells.filter((i) => posees.has(i)).length;
        const main = move.words.reduce((a, b) => {
          if (aPoser(b) !== aPoser(a)) return aPoser(b) > aPoser(a) ? b : a;
          if (b.word.length !== a.word.length) return b.word.length > a.word.length ? b : a;
          return b.score > a.score ? b : a;
        });
        // La case annoncée est le début du mot nommé, non la première lettre
        // posée : c'est là que le joueur va poser les yeux.
        this.toast(`Essayez ${main.word} en ${coordName(main.cells[0])} (+${move.score})`);
      }
      this.renderControls();
      return;
    }

    // Un temps de réflexion minimal évite un coup qui « claque » sans transition.
    const elapsed = performance.now() - this.thinkingSince;
    let attendu = THINKING_FLOOR_MS + Math.random() * THINKING_JITTER_MS;
    // Une félicitation vient peut-être de s'afficher : l'adversaire attend
    // qu'on ait fini de la lire avant de poser son coup par-dessus.
    if (this.felicitationJusqua) {
      attendu = Math.max(attendu, this.felicitationJusqua - this.thinkingSince);
      this.felicitationJusqua = 0;
    }
    if (elapsed < attendu) await new Promise((r) => setTimeout(r, attendu - elapsed));

    this.applyComputerDecision(message.decision);
  }

  applyComputerDecision(decision) {
    const name = this.game.players[COMPUTER].name;

    if (decision.type === 'play') {
      const result = this.game.play(decision.move.placements, this.dawg);
      if (result.ok) {
        this.revealCells = [...this.game.lastMoveCells];
        this.revealKind = 'land';
        // Les tuiles se révèlent un à un : les claquements suivent le même pas,
        // et l'on entend la longueur du mot avant de l'avoir lu.
        this.sons.jouerSerie('adverse', this.revealCells.length, REVEAL_STEP_MS);
        const words = result.words.map((w) => w.word).join(', ');
        this.toast(result.bingo ? `${name} scrabble : ${words} (+${result.score})` : `${name} : ${words} (+${result.score})`);
        if (result.bingo) {
          this.sons.jouer('scrabble', (this.revealCells.length * REVEAL_STEP_MS) / 1000);
          this.replay(this.boardEl, 'bingo');
        }
      } else {
        // Garde-fou : plutôt passer que bloquer la partie sur un coup rejeté.
        this.game.pass();
        this.toast(`${name} passe son tour.`);
      }
    } else if (decision.type === 'exchange') {
      const result = this.game.exchange(decision.tiles);
      if (!result.ok) this.game.pass();
      this.sons.jouer('echange');
      this.toast(`${name} échange ${decision.tiles.length} tuile${decision.tiles.length > 1 ? 's' : ''}.`);
    } else {
      this.game.pass();
      this.toast(`${name} passe son tour.`);
    }

    this.busy = false;
    $('thinking').hidden = true;
    this.prunePending();
    this.save();
    this.render();

    if (this.game.finished) this.showEnd();
    else this.verifierBlocage();
  }

  /* ---------------------------------------------------------------- */
  /* Fin de partie                                                     */
  /* ---------------------------------------------------------------- */

  showEnd() {
    $('end-title').textContent = this.endSentence();
    $('end-detail').textContent = this.game.endReason ?? '';

    // Les noms viennent du réseau : montés en éléments, jamais en balisage.
    const scores = $('end-scores');
    scores.textContent = '';
    scores.dataset.seats = String(this.game.players.length);
    this.game.players.forEach((player, seat) => {
      const block = document.createElement('div');
      if (this.game.winner === seat) block.className = 'won';
      const name = document.createElement('div');
      name.className = 'n';
      name.textContent = this.seatName(seat);
      const value = document.createElement('div');
      value.className = 'v';
      value.textContent = String(player.score);
      block.append(name, value);
      scores.append(block);
    });

    $('end-dialog').showModal();
    this.sons.jouer(this.game.winner === HUMAN ? 'victoire' : 'defaite');
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

    this.bindChat();

    $('btn-multi').onclick = () => this.openMultiplayer();
    $('mp-close').onclick = () => $('mp-dialog').close();

    const nameField = $('mp-name');
    nameField.value = this.myName;
    nameField.onchange = () => {
      // Le champ n'est jamais repeuplé d'un nom par défaut : le laisser vide
      // est un choix valable, et y réécrire obligerait à l'effacer encore.
      this.myName = nameField.value.trim().slice(0, 18);
      nameField.value = this.myName;
      try {
        localStorage.setItem(NAME_KEY, this.myName);
      } catch {
        /* stockage indisponible : le nom vaudra pour cette session */
      }
    };

    const seatPicker = $('mp-seats');
    for (const option of seatPicker.children) {
      option.onclick = () => {
        this.tableSize = Number(option.dataset.seats);
        for (const other of seatPicker.children) {
          const chosen = other === option;
          other.classList.toggle('selected', chosen);
          other.setAttribute('aria-checked', String(chosen));
        }
      };
    }

    $('mp-create').onclick = () => {
      nameField.onchange();
      this.startHosting();
    };

    $('mp-start').onclick = () => this.startNetworkGame();

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

    // Un onglet passé en arrière-plan peut voir sa liaison coupée par le
    // téléphone. Au retour, on la rétablit tout de suite plutôt que
    // d'attendre le prochain essai programmé.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.mode === 'solo' || !this.session) return;
      if (!this.session.connected) this.session.resumeNow();
    });

    // Un lien d'invitation ouvre directement la fenêtre de connexion.
    const invited = codeFromLocation();
    if (invited) {
      codeField.value = invited;
      $('mp-dialog').showModal();
      this.startJoining(invited);
    }
  }

  /**
   * Fait onduler les tuiles de la marque, de gauche à droite.
   *
   * Un nouveau clic reprend la vague depuis le début : les animations en
   * cours sont annulées explicitement, sans quoi deux clics rapprochés
   * donnent l'impression de deux vagues qui se suivent.
   */
  wiggleBrand() {
    const tiles = [...document.querySelectorAll('.brand-tile')];

    // Le son passe avant le garde-fou : qui demande moins d'animations n'a
    // pas demandé moins de surprises, et sans lui l'œuf de Pâques n'existe
    // plus du tout pour cette personne. Le nombre de lettres et leur décalage
    // partent avec, pour qu'une lame de xylophone tombe sur chacune.
    this.sons.jouer('logo', 0, { lettres: tiles.length, pas: BRAND_WAVE_STEP_MS });
    if (reducedMotion.matches) return;

    tiles.forEach((tile, i) => {
      for (const animation of tile.getAnimations()) animation.cancel();
      tile.classList.remove('wiggle');
      tile.style.animationDelay = `${i * BRAND_WAVE_STEP_MS}ms`;
    });
    // Recalcul forcé : sans lui, retirer puis remettre la classe dans la même
    // image ne relance pas l'animation.
    const mascot = document.querySelector('.brand-mascot');
    for (const animation of mascot?.getAnimations() ?? []) animation.cancel();
    mascot?.classList.remove('hop');

    void tiles[0]?.offsetWidth;
    for (const tile of tiles) tile.classList.add('wiggle');
    mascot?.classList.add('hop');
  }

  openMultiplayer() {
    $('mp-choice').hidden = this.mode !== 'solo';
    $('mp-invite').hidden = this.mode !== 'host' || !this.session?.code;
    $('mp-waiting').hidden = this.mode !== 'guest' || this.netStarted;
    $('mp-leave').hidden = this.mode === 'solo';
    if (this.mode === 'solo') this.setNetStatus('');
    this.renderRoster();
    $('mp-dialog').showModal();
  }

  /* --- La table ----------------------------------------------------- */

  /**
   * Places de la partie en ligne, dans l'ordre du tour. L'hôte occupe la
   * première ; chaque invité est reconnu à son jeton et non à sa liaison,
   * qui change à chaque reconnexion.
   *
   * @type {{token: string, id: string|null, name: string}[]}
   */
  resetSeats() {
    this.seats = [{ token: myToken(), id: null, name: this.playerName() }];
  }

  seatOfToken(token) {
    return this.seats.findIndex((seat) => seat.token === token);
  }

  seatOfConn(id) {
    return this.seats.findIndex((seat) => seat.id === id);
  }

  /** Noms de la table, hôte en tête. */
  tableNames() {
    return this.seats.map((seat) => seat.name);
  }

  /** Liste des joueurs attablés, dans la fenêtre de mise en relation. */
  renderRoster() {
    const list = this.mode === 'host' ? $('mp-roster') : $('mp-roster-guest');
    if (!list) return;
    list.textContent = '';

    const names = this.mode === 'host' ? this.tableNames() : (this.lobbyNames ?? []);
    const size = this.mode === 'host' ? this.tableSize : (this.lobbySize ?? names.length);

    names.forEach((name, seat) => {
      const item = document.createElement('li');
      item.className = 'mp-player';
      const who = document.createElement('span');
      // Nom venu du réseau : posé en texte, jamais interprété.
      who.textContent = name;
      item.append(who);
      if (seat === 0) {
        const tag = document.createElement('span');
        tag.className = 'mp-tag';
        tag.textContent = 'hôte';
        item.append(tag);
      }
      list.append(item);
    });

    // Les places encore vides se montrent : on voit qui l'on attend.
    for (let n = names.length; n < size; n++) {
      const item = document.createElement('li');
      item.className = 'mp-player empty';
      item.textContent = 'Place libre…';
      list.append(item);
    }

    if (this.mode === 'host' && !this.netStarted) {
      // Lancer devient possible dès qu'il y a de quoi jouer, sans attendre
      // que la table soit pleine.
      const ready = this.seats.length >= MIN_PLAYERS;
      $('mp-start').hidden = !ready;
      $('mp-start').textContent =
        this.seats.length === this.tableSize
          ? 'Lancer la partie'
          : `Lancer à ${this.seats.length} joueurs`;
    } else {
      $('mp-start').hidden = true;
    }
  }

  /* --- Établissement de la liaison --------------------------------- */

  startHosting() {
    this.teardownSession();
    this.mode = 'host';
    this.netStarted = false;
    this.resetSeats();

    this.session = new PeerSession({
      onStatus: (text) => this.setNetStatus(text),
      onReady: (code) => {
        $('mp-choice').hidden = true;
        $('mp-invite').hidden = false;
        $('mp-leave').hidden = false;
        $('mp-code-value').textContent = code;
        this.renderRoster();
      },
      onConnected: () => this.setNetStatus('Un joueur se présente…', 'live'),
      onData: (message, id) => this.onPeerData(message, id),
      onGuestGone: (id) => this.onGuestGone(id),
      onDropped: (reason) => this.onPeerDropped(reason),
      onResumed: () => this.onPeerResumed(),
      onClosed: (reason) => this.onPeerLost(reason),
      onError: (message) => this.onPeerError(message),
    });

    // Une place pour chacun, l'hôte excepté : il tient déjà la sienne.
    this.session.capacity = this.tableSize - 1;
    this.session.host();
    this.renderNetChip();
  }

  startJoining(code) {
    this.teardownSession();
    this.mode = 'guest';
    this.netStarted = false;
    this.lobbyNames = [];
    this.lobbySize = 0;

    this.session = new PeerSession({
      onStatus: (text) => this.setNetStatus(text),
      onConnected: () => {
        this.setNetStatus('Connecté. En attente de la partie…', 'live');
        $('mp-choice').hidden = true;
        $('mp-leave').hidden = false;
        // Le code a rempli son office : on le retire de l'adresse pour qu'un
        // rechargement ne relance pas une connexion vers une partie close.
        clearLocationCode();
        this.session.send({ t: 'hello', name: this.playerName(), token: myToken() });
      },
      onData: (message) => this.onPeerData(message),
      onDropped: (reason) => this.onPeerDropped(reason),
      onResumed: () => this.onPeerResumed(),
      onClosed: (reason) => this.onPeerLost(reason),
      onError: (message) => this.onPeerError(message),
    });

    this.session.join(code);
    this.renderNetChip();
  }

  /** Nouvelle partie en ligne : seul l'hôte la crée, puis la diffuse. */
  startNetworkGame() {
    if (this.seats.length < MIN_PLAYERS) {
      this.toast('Il manque encore un joueur.', 'error');
      return;
    }

    this.netStarted = true;
    // Le premier à jouer est tiré au sort parmi tous les présents : à quatre,
    // commencer serait un avantage systématique pour l'hôte.
    const first = Math.floor(Math.random() * this.seats.length);
    this.game = new Game({ names: this.tableNames(), firstPlayer: first });

    this.pending.clear();
    this.selected = null;
    this.cursor = null;
    this.cancelExchange();
    this.scoreCards = null;

    this.sendWelcome();
    this.render();
    this.broadcast();
    $('mp-dialog').close();
    this.toast(
      first === HUMAN ? 'Partie lancée. Vous commencez.' : `Partie lancée. ${this.seatName(first)} commence.`,
    );
  }

  /** Annonce à chacun que la partie démarre, avec la table telle qu'elle est. */
  sendWelcome() {
    this.seats.forEach((seat, index) => {
      if (index === HUMAN) return;
      this.session.sendTo(seat.id, { t: 'welcome', names: this.tableNames() });
    });
  }

  /** Diffuse l'état de la partie, un instantané par siège. */
  broadcast() {
    if (this.mode !== 'host' || !this.game) return;
    this.seats.forEach((seat, index) => {
      if (index === HUMAN || !seat.id) return;
      this.session.sendTo(seat.id, { t: 'state', snap: this.game.snapshot(index) });
    });
  }

  /** Annonce la composition de la table à ceux qui attendent. */
  broadcastLobby() {
    if (this.mode !== 'host' || this.netStarted) return;
    this.session.send({ t: 'lobby', names: this.tableNames(), size: this.tableSize });
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

  /* --- Échange de messages ----------------------------------------- */

  onPeerData(message, id) {
    switch (message.t) {
      case 'hello':
        if (this.mode !== 'host') return;
        this.welcomeGuest(message, id);
        return;

      case 'lobby':
        if (this.mode !== 'guest' || this.netStarted) return;
        this.lobbyNames = this.safeNames(message.names);
        this.lobbySize = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Math.trunc(Number(message.size)) || MIN_PLAYERS));
        $('mp-waiting').hidden = false;
        this.setNetStatus(
          this.lobbyNames.length >= this.lobbySize
            ? 'Table complète. La partie va commencer…'
            : 'En attente des autres joueurs…',
          'live',
        );
        this.renderRoster();
        return;

      case 'welcome':
        if (this.mode !== 'guest') return;
        this.netStarted = true;
        $('mp-waiting').hidden = true;
        this.scoreCards = null;
        return;

      case 'state':
        if (this.mode !== 'guest') return;
        this.applySnapshot(message.snap);
        return;

      case 'chat':
        this.onChat(message, id);
        return;

      case 'reject':
        if (this.mode !== 'guest') return;
        this.busy = false;
        this.toast(String(message.reason ?? 'Coup refusé.'), 'error');
        this.sons.jouer('refus');
        this.refresh();
        return;

      case 'busy':
        this.toast('Cette partie est complète.', 'error');
        this.leaveMultiplayer();
        return;

      case 'play':
      case 'pass':
      case 'exchange':
      case 'resign':
      case 'rematch':
        if (this.mode === 'host') this.handleGuestIntent(message, id);
        return;

      default:
        return;
    }
  }

  /**
   * Installe un joueur à la table, ou le rend à sa place.
   *
   * Un jeton déjà connu est un revenant : sa place l'attend, même si la
   * partie a continué sans lui et même si la table est pleine. Un jeton
   * inconnu ne peut s'asseoir qu'avant le premier coup.
   */
  welcomeGuest(message, id) {
    const name = this.cleanName(message.name);
    const token = this.safeToken(message.token);
    const known = token ? this.seatOfToken(token) : -1;

    if (known >= 0) {
      this.seats[known].id = id;
      this.seats[known].name = name;
      if (this.netStarted) {
        this.game.players[known].name = name;
        this.session.sendTo(id, { t: 'welcome', names: this.tableNames() });
        this.session.sendTo(id, { t: 'state', snap: this.game.snapshot(known) });
        this.setNetStatus(`${name} a repris la partie.`, 'live');
        this.toast(`${name} a repris la partie.`);
        this.render();
        return;
      }
      this.afterSeatChange();
      return;
    }

    if (this.netStarted || this.seats.length >= this.tableSize) {
      this.session.sendTo(id, { t: 'busy' });
      return;
    }

    this.seats.push({ token, id, name });
    this.toast(`${name} rejoint la partie.`);
    this.afterSeatChange();

    // Table complète : plus rien à attendre, on distribue.
    if (this.seats.length === this.tableSize) this.startNetworkGame();
  }

  /** Un invité a quitté la liaison : sa place reste, lui non. */
  onGuestGone(id) {
    const seat = this.seatOfConn(id);
    if (seat < 0) return;
    this.seats[seat].id = null;

    if (!this.netStarted) {
      // Avant le premier coup, un partant libère vraiment sa place.
      const [gone] = this.seats.splice(seat, 1);
      this.toast(`${gone.name} a quitté la table.`);
      this.afterSeatChange();
      return;
    }

    this.setNetStatus(`${this.seats[seat].name} s’est déconnecté.`, 'error');
    this.toast(`${this.seats[seat].name} s’est déconnecté. Il peut revenir avec le même code.`);
    this.render();
  }

  afterSeatChange() {
    this.setNetStatus(
      this.seats.length >= this.tableSize
        ? 'Table complète.'
        : `En attente des autres joueurs (${this.seats.length}/${this.tableSize})…`,
      'live',
    );
    this.renderRoster();
    this.broadcastLobby();
    this.renderNetChip();
  }

  /**
   * Arbitrage d'une intention reçue d'un invité. Le contenu vient du réseau :
   * il est ramené à des valeurs sûres avant d'atteindre le moteur, qui
   * revérifie de toute façon chevalet, géométrie et dictionnaire.
   */
  handleGuestIntent(message, id) {
    const seat = this.seatOfConn(id);
    if (seat < 0) return;

    if (message.t === 'rematch') {
      // Une revanche appartient à l'hôte : sinon le premier invité impatient
      // rebattrait les cartes des autres.
      if (!this.game?.finished) return;
      this.toast(`${this.seats[seat].name} demande une revanche.`);
      return;
    }

    if (message.t === 'resign') {
      this.endByResignation(seat);
      return;
    }

    if (this.game.finished || this.game.current !== seat) {
      this.session.sendTo(id, { t: 'reject', reason: 'Ce n’est pas votre tour.' });
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
      this.session.sendTo(id, { t: 'reject', reason: result.reason });
      return;
    }

    const name = this.seats[seat].name;
    if (message.t === 'play') {
      this.revealCells = [...this.game.lastMoveCells];
      this.revealKind = 'land';
      const words = result.words.map((w) => w.word).join(', ');
      this.toast(
        result.bingo
          ? `Scrabble de ${name} ! ${words} +${result.score}`
          : `${name} : ${words} +${result.score}`,
      );
      this.sons.jouerSerie('adverse', this.revealCells.length, REVEAL_STEP_MS);
      if (result.bingo) this.replay(this.boardEl, 'bingo');
    } else if (message.t === 'exchange') {
      this.toast(`${name} a échangé des tuiles.`);
    } else {
      this.toast(`${name} passe son tour.`);
    }

    this.render();
    this.broadcast();
    this.afterTurn();
  }

  /**
   * Un joueur abandonne : la partie s'arrête et revient au meilleur des
   * autres. À deux c'est l'adversaire ; à quatre, celui qui menait.
   */
  endByResignation(seat) {
    const others = this.game.players
      .map((player, index) => ({ index, score: player.score }))
      .filter((entry) => entry.index !== seat)
      .sort((a, b) => b.score - a.score);

    this.game.finished = true;
    this.game.winner = others.length && others[0].score !== others[1]?.score ? others[0].index : null;
    this.game.endReason = `${this.seatName(seat)} a abandonné la partie.`;
    this.render();
    this.broadcast();
    this.showEnd();
  }

  /** Applique un instantané reçu de l'hôte. */
  applySnapshot(snap) {
    const before = this.game?.history?.length ?? 0;
    this.game = Game.fromSnapshot(snap);
    if (this.scoreCards && this.scoreCards.length !== this.game.players.length) {
      this.scoreCards = null;
    }
    this.netStarted = true;

    const entry = snap.history.length > before ? snap.history.at(-1) : null;

    // Un coup préparé survit au coup d'un autre : mon chevalet n'a pas bougé,
    // mes poses restent les miennes — seules tombent celles dont la case
    // vient d'être prise. Mon propre coup validé, lui, renouvelle le
    // chevalet : les poses y référeraient les mauvaises lettres.
    if (entry && entry.player !== HUMAN) this.prunePending();
    else this.pending.clear();

    this.selected = null;
    this.busy = false;
    this.cancelExchange();
    if (this.pending.size === 0) this.cursor = null;

    if (entry && entry.player !== HUMAN) {
      const name = this.seatName(entry.player);
      this.revealCells = [...(snap.lastMoveCells ?? [])];
      this.revealKind = 'land';
      if (entry.type === 'play') {
        this.sons.jouerSerie('adverse', this.revealCells.length, REVEAL_STEP_MS);
        const words = entry.words.join(', ');
        this.toast(
          entry.bingo
            ? `Scrabble de ${name} ! ${words} +${entry.score}`
            : `${name} : ${words} +${entry.score}`,
        );
        if (entry.bingo) {
          this.sons.jouer('scrabble', (this.revealCells.length * REVEAL_STEP_MS) / 1000);
          this.replay(this.boardEl, 'bingo');
        }
      } else if (entry.type === 'exchange') {
        this.sons.jouer('echange');
        this.toast(`${name} a échangé des tuiles.`);
      } else {
        this.toast(`${name} passe son tour.`);
      }
    }

    $('mp-dialog').close();
    this.render();
    if (this.game.finished) this.showEnd();
    else this.verifierBlocage();
  }


  /* ---------------------------------------------------------------- */
  /* Tchat                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * L'hôte relaie : un invité n'écrit qu'à lui, et c'est lui qui redistribue
   * en estampillant l'auteur. Personne ne peut donc parler sous le nom d'un
   * autre — le nom transmis dans le message n'est jamais cru sur parole.
   */
  onChat(message, id) {
    const text = this.safeChat(message.text);
    if (!text) return;

    if (this.mode === 'host') {
      const seat = this.seatOfConn(id);
      if (seat < 0) return;
      const from = this.seats[seat].name;
      this.pushChat(from, text, false);
      this.session.sendExcept(id, { t: 'chat', from, text });
      return;
    }

    this.pushChat(this.cleanName(message.from), text, false);
  }

  /** Envoie un message, et l'inscrit chez soi sans attendre l'écho. */
  sendChat(text) {
    const clean = this.safeChat(text);
    if (!clean || this.mode === 'solo' || !this.session) return;

    this.pushChat(this.playerName(), clean, true);
    if (this.mode === 'host') {
      this.session.send({ t: 'chat', from: this.playerName(), text: clean });
    } else {
      this.session.send({ t: 'chat', text: clean });
    }
  }

  pushChat(from, text, mine) {
    this.chat.push({ from, text, mine });
    // Le fil ne sert qu'à relire les derniers échanges : au-delà, il n'a
    // plus d'usage et pèse sur l'affichage.
    if (this.chat.length > CHAT_MEMORY) this.chat.shift();

    const open = $('chat-dialog').open;
    if (!mine && !open) {
      this.unread++;
      this.sons.jouer('message');
    }
    if (!mine) this.showBubble(from, text);
    this.renderChat();
    this.renderChatBadge();
  }

  renderChat() {
    const log = $('chat-log');
    log.textContent = '';
    for (const entry of this.chat) {
      const item = document.createElement('li');
      item.className = `chat-line${entry.mine ? ' mine' : ''}`;
      if (this.isEmoji(entry.text)) item.classList.add('solo-emoji');

      const who = document.createElement('span');
      who.className = 'chat-who';
      // Tout vient du réseau : posé en texte, jamais interprété.
      who.textContent = entry.mine ? 'Vous' : entry.from;

      const what = document.createElement('span');
      what.className = 'chat-what';
      what.textContent = entry.text;

      item.append(who, what);
      log.append(item);
    }
    this.scrollChat();
  }

  renderChatBadge() {
    const badge = $('chat-badge');
    badge.hidden = this.unread === 0;
    badge.textContent = String(Math.min(this.unread, 9));
  }

  /**
   * Bulle éphémère au-dessus du plateau : on voit passer ce qui se dit sans
   * quitter son coup des yeux. Les bulles s'empilent et s'effacent seules.
   */
  showBubble(from, text) {
    const zone = $('chat-bubbles');
    const bubble = document.createElement('div');
    bubble.className = this.isEmoji(text) ? 'chat-bubble big' : 'chat-bubble';

    const who = document.createElement('span');
    who.className = 'bubble-who';
    who.textContent = from;
    const what = document.createElement('span');
    what.textContent = text;

    bubble.append(who, what);
    zone.append(bubble);
    while (zone.children.length > BUBBLE_STACK) zone.firstElementChild.remove();
    setTimeout(() => bubble.remove(), BUBBLE_MS);
  }

  /** Un message fait-il d'une seule émoticône ? Il s'affiche alors en grand. */
  isEmoji(text) {
    return [...text].length <= 2 && /\p{Extended_Pictographic}/u.test(text);
  }

  openChat() {
    this.unread = 0;
    this.renderChatBadge();
    this.renderChat();
    const sheet = $('chat-dialog');
    sheet.showModal();
    sheet.focus();
    // Le journal est encore masqué au moment du rendu : sa hauteur vaut
    // alors zéro et le défilement ne mène nulle part. On le refait une fois
    // la fenêtre ouverte, pour arriver sur le dernier message.
    this.scrollChat();
  }

  scrollChat() {
    const log = $('chat-log');
    log.scrollTop = log.scrollHeight;
  }

  bindChat() {
    const row = $('emoji-row');
    for (const emoji of EMOJIS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'emoji';
      button.textContent = emoji;
      button.setAttribute('aria-label', `Envoyer ${emoji}`);
      // Un appui, c'est parti : c'est tout l'intérêt d'une réaction rapide.
      button.onclick = () => this.sendChat(emoji);
      row.append(button);
    }

    $('btn-chat').onclick = () => this.openChat();
    $('chat-close').onclick = () => $('chat-dialog').close();

    $('chat-form').onsubmit = (event) => {
      event.preventDefault();
      const field = $('chat-input');
      this.sendChat(field.value);
      field.value = '';
    };
  }

  /** Message reçu du réseau : ramené à une ligne de texte sans balisage. */
  safeChat(raw) {
    return String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CHAT_MAX);
  }

  safeNames(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_PLAYERS).map((name) => this.cleanName(name));
  }

  safeToken(raw) {
    const token = String(raw ?? '').replace(/[^A-Z0-9]/gi, '').slice(0, 24);
    return token || null;
  }

  /* --- Assainissement des messages reçus ---------------------------- */

  /** Nom à transmettre : celui du joueur, ou un nom neutre s'il n'en a pas mis. */
  playerName() {
    return this.myName.trim() || DEFAULT_NAME;
  }

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

  /**
   * Liaison rompue mais pas perdue : la partie reste entière, la session
   * rappelle d'elle-même. Rien n'est démonté — c'est tout l'intérêt.
   */
  onPeerDropped(reason) {
    this.busy = false;
    this.setNetStatus(reason, 'error');
    this.toast(reason, 'error');
    this.render();
  }

  onPeerResumed() {
    this.setNetStatus('Liaison rétablie.', 'live');
    this.toast('Liaison rétablie.');
    this.render();
  }

  onPeerError(message) {
    this.busy = false;
    this.setNetStatus(message, 'error');
    $('mp-choice').hidden = false;
    $('mp-invite').hidden = true;
    $('mp-waiting').hidden = true;
    this.mode = 'solo';
    this.seats = [];
    this.renderChatMode();
    this.renderNetChip();
  }

  leaveMultiplayer() {
    this.teardownSession();
    this.mode = 'solo';
    this.netStarted = false;
    this.seats = [];
    this.lobbyNames = [];
    this.chat = [];
    this.unread = 0;
    this.scoreCards = null;
    clearLocationCode();
    this.setNetStatus('');
    $('mp-choice').hidden = false;
    $('mp-invite').hidden = true;
    $('mp-waiting').hidden = true;
    $('mp-leave').hidden = true;
    $('chat-dialog').close();
    this.renderChatMode();

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
    else this.verifierBlocage();
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

  /**
   * Ce que dit la pastille de liaison : à deux, le nom de l'adversaire, seul
   * renseignement utile ; au-delà, un décompte, parce que trois noms ne
   * tiennent pas dans l'en-tête d'un téléphone.
   */
  tableLabel() {
    const others = (this.game?.players?.length ?? 2) - 1;
    if (others <= 1) return this.seatName(1);
    return `${others + 1} joueurs`;
  }

  /** Le tchat n'a de sens qu'avec quelqu'un en face. */
  renderChatMode() {
    $('btn-chat').hidden = this.mode === 'solo';
    this.renderChatBadge();
  }

  renderNetChip() {
    this.renderChatMode();
    const chip = $('netchip');
    if (this.mode === 'solo') {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    const live = Boolean(this.session?.connected);
    const reprise = !live && Boolean(this.session?.reconnecting);
    chip.className = `netchip ${live ? 'live' : 'lost'}`;
    // Le libellé vit dans son propre élément : c'est lui qui se tronque quand
    // l'en-tête manque de place, la pastille de couleur restant visible.
    chip.textContent = '';
    const label = document.createElement('span');
    label.className = 'netchip-label';
    // « Reprise… » plutôt que « Reconnexion… » : à 390 px de large, le mot
    // entier ne tient pas et se ferait tronquer.
    label.textContent = live ? this.tableLabel() : reprise ? 'Reprise…' : 'Hors ligne';
    chip.append(label);
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
