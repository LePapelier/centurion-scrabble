/**
 * Bruitages du jeu, synthétisés à la volée.
 *
 * Rien n'est téléchargé : tout sort d'oscillateurs et d'un peu de bruit blanc
 * filtré. Un jeu de sons enregistrés pèserait quelques centaines de kilooctets
 * pour un résultat qu'on n'entend qu'une demi-seconde, et poserait la question
 * de leur provenance. Ici le code fait dix fois moins que le seul fichier
 * qu'il remplace.
 *
 * Le parti pris sonore est celui du bois : les jetons de Scrabble claquent,
 * ils ne bipent pas. D'où le bruit filtré plutôt que des notes pures pour tout
 * ce qui touche au plateau — les notes sont réservées aux trois moments qui
 * méritent qu'on lève la tête (le scrabble, le coup optimal, la fin).
 */

/** Réglage d'ensemble : tout passe par là, et rien ne doit dominer la pièce. */
export const VOLUME_MAITRE = 0.85;

/*
 * Un filtre passe-bande ne laisse qu'une tranche du bruit blanc qu'on lui
 * donne : il en sort six à neuf fois plus faible qu'il n'y est entré. Les
 * oscillateurs, eux, ne perdent que le temps de l'enveloppe. Sans compenser,
 * un claquement réglé à 0,3 s'entend trois fois moins qu'une note réglée à
 * 0,3, et les `volume` ci-dessous ne voudraient plus rien dire les uns par
 * rapport aux autres. Ces deux constantes remettent les deux familles sur la
 * même échelle : ensuite, `volume` se lit comme une intention.
 */
const GAIN_BRUIT = 4.6;
const GAIN_NOTE = 3.1;

export class Sons {
  constructor(actifs = true) {
    this.actifs = actifs;
    /** @type {AudioContext|null} créé au premier geste, jamais avant. */
    this.ctx = null;
    this.maitre = null;
    this.bruit = null;
  }

  /**
   * Les navigateurs refusent tout son tant que la personne n'a pas touché la
   * page : le contexte naît donc au premier geste, et se réveille aux suivants
   * (revenir d'un autre onglet le suspend).
   */
  reveiller() {
    if (!this.actifs) return null;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.maitre = this.ctx.createGain();
      this.maitre.gain.value = VOLUME_MAITRE;
      this.maitre.connect(this.ctx.destination);
      this.bruit = this.fabriquerBruit();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /** Une seconde de bruit blanc, réutilisée par tous les claquements. */
  fabriquerBruit() {
    const longueur = this.ctx.sampleRate;
    const tampon = this.ctx.createBuffer(1, longueur, this.ctx.sampleRate);
    const données = tampon.getChannelData(0);
    for (let i = 0; i < longueur; i++) données[i] = Math.random() * 2 - 1;
    return tampon;
  }

  /* ---------------------------------------------------------------- */
  /* Briques élémentaires                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Un claquement : bruit blanc passé dans un filtre étroit, étouffé aussitôt.
   * La fréquence du filtre fait toute la matière — bas, c'est un jeton lourd
   * sur le plateau ; haut, c'est un jeton qu'on effleure.
   */
  claquer({ freq = 1400, duree = 0.06, volume = 0.3, retard = 0, q = 1.4 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + retard;

    const source = ctx.createBufferSource();
    source.buffer = this.bruit;
    source.playbackRate.value = 0.8 + Math.random() * 0.4; // deux jetons ne sonnent jamais pareil

    const filtre = ctx.createBiquadFilter();
    filtre.type = 'bandpass';
    filtre.frequency.value = freq;
    filtre.Q.value = q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume * GAIN_BRUIT, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duree);

    source.connect(filtre).connect(gain).connect(this.maitre);
    source.start(t);
    source.stop(t + duree + 0.02);
  }

  /** Une note, pour les moments qui se remarquent. */
  note({ freq, duree = 0.18, volume = 0.16, retard = 0, forme = 'triangle' }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + retard;

    const osc = ctx.createOscillator();
    osc.type = forme;
    osc.frequency.value = freq;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume * GAIN_NOTE, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duree);

    osc.connect(gain).connect(this.maitre);
    osc.start(t);
    osc.stop(t + duree + 0.02);
  }

  /**
   * Une frappe de peau : une sinusoïde qui chute en fréquence aussitôt jouée.
   * C'est tout le secret d'une grosse caisse — l'oreille entend la descente
   * comme un choc, là où une note tenue à 50 Hz ne serait qu'un bourdon.
   */
  frappe({ depart = 140, arrivee = 45, duree = 0.3, volume = 0.5, retard = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + retard;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(depart, t);
    osc.frequency.exponentialRampToValueAtTime(arrivee, t + duree * 0.6);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duree);

    osc.connect(gain).connect(this.maitre);
    osc.start(t);
    osc.stop(t + duree + 0.02);

    // Le claquement de la mailloche sur la peau, sans quoi le coup est mou.
    this.claquer({ freq: 1800, duree: 0.03, volume: volume * 0.16, retard, q: 0.8 });
  }

  /**
   * Une lame de xylophone. Ce qui la distingue d'une note ordinaire, c'est
   * son harmonique aiguë : sur un vrai instrument, la lame est creusée pour
   * que son premier partiel tombe à trois fois le fondamental, et non deux.
   * D'où ce timbre sec et cristallin qu'aucune sinusoïde seule ne donne.
   */
  lame({ freq, duree = 0.3, volume = 0.3, retard = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + retard;

    for (const [rapport, part, tenue] of [[1, 1, 1], [3, 0.4, 0.55], [6.2, 0.14, 0.3]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * rapport;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(volume * part, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + duree * tenue);

      osc.connect(gain).connect(this.maitre);
      osc.start(t);
      osc.stop(t + duree + 0.02);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Le répertoire                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * @param {string} nom
   * @param {number} [retard] en secondes, pour étaler une série
   */
  jouer(nom, retard = 0) {
    if (!this.reveiller()) return;

    switch (nom) {
      // Un jeton qu'on soulève : bref et haut, presque rien.
      case 'prise':
        this.claquer({ freq: 2600, duree: 0.035, volume: 0.10, retard });
        break;

      // Un jeton qu'on pose sur le plateau. C'est le son le plus entendu de
      // tout le jeu : il doit rester en dessous de l'attention.
      case 'pose':
        this.claquer({ freq: 1500, duree: 0.055, volume: 0.22, retard });
        break;

      // Le coup part : le même bois, en plus plein, suivi d'une note courte
      // qui vient dire « c'est compté ».
      case 'coup':
        this.claquer({ freq: 900, duree: 0.09, volume: 0.29, retard, q: 1.1 });
        this.note({ freq: 523.25, duree: 0.12, volume: 0.1, retard: retard + 0.05 });
        break;

      // L'adversaire pose : même geste, plus sourd, pour qu'on sache sans
      // regarder que ce n'est pas nous.
      case 'adverse':
        this.claquer({ freq: 620, duree: 0.085, volume: 0.40, retard, q: 1.1 });
        break;

      // Coup refusé : deux notes qui descendent, étouffées. Jamais d'alarme —
      // se tromper au Scrabble n'est pas une faute.
      case 'refus':
        this.note({ freq: 233.08, duree: 0.13, volume: 0.12, retard, forme: 'sine' });
        this.note({ freq: 185, duree: 0.2, volume: 0.12, retard: retard + 0.09, forme: 'sine' });
        break;

      // Scrabble : les sept jetons d'un coup, quatre notes qui montent.
      case 'scrabble':
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          this.note({ freq: f, duree: 0.26, volume: 0.15, retard: retard + i * 0.085 });
        });
        break;

      // Coup optimal : deux notes, une quinte, claires et vite passées. La
      // félicitation doit faire sourire, pas interrompre.
      case 'optimal':
        this.note({ freq: 880, duree: 0.2, volume: 0.13, retard });
        this.note({ freq: 1318.51, duree: 0.34, volume: 0.11, retard: retard + 0.1 });
        break;

      // Fin de partie : une cadence qui monte si l'on gagne, qui retombe sinon.
      case 'victoire':
        [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => {
          this.note({ freq: f, duree: 0.42, volume: 0.14, retard: retard + i * 0.11 });
        });
        break;

      case 'defaite':
        [587.33, 493.88, 392].forEach((f, i) => {
          this.note({ freq: f, duree: 0.42, volume: 0.12, retard: retard + i * 0.14, forme: 'sine' });
        });
        break;

      // La marque qu'on chatouille. Deux frappes — le « ba » de l'élan, le
      // « boum » de la retombée — puis une cascade de xylophone qui monte,
      // calée sur la vague qui parcourt les lettres à l'écran.
      //
      // La gamme est pentatonique : n'importe quelles notes s'y enchaînent
      // sans jamais frotter, ce qu'une gamme ordinaire ne pardonne pas à
      // cette vitesse.
      case 'logo': {
        this.frappe({ depart: 170, arrivee: 82, duree: 0.16, volume: 0.30, retard });
        this.frappe({ depart: 130, arrivee: 42, duree: 0.42, volume: 0.50, retard: retard + 0.19 });
        const gamme = [
          523.25, 587.33, 659.25, 783.99, 880,
          1046.5, 1174.66, 1318.51, 1567.98, 1760,
          2093, 2349.32, 2637.02,
        ];
        gamme.forEach((f, i) => {
          this.lame({ freq: f, duree: 0.34, volume: 0.24, retard: retard + 0.22 + i * 0.028 });
        });
        break;
      }

      // Jetons rendus au sac : un froissement plus long, deux passes.
      case 'echange':
        this.claquer({ freq: 3200, duree: 0.13, volume: 0.14, retard, q: 0.7 });
        this.claquer({ freq: 2400, duree: 0.16, volume: 0.12, retard: retard + 0.07, q: 0.7 });
        break;

      default:
        break;
    }
  }

  /** Une série de poses, espacées comme les jetons qui se révèlent à l'écran. */
  jouerSerie(nom, nombre, pasMs) {
    for (let i = 0; i < nombre; i++) this.jouer(nom, (i * pasMs) / 1000);
  }
}
