/**
 * Liaison directe entre navigateurs, sans serveur applicatif.
 *
 * WebRTC exige tout de même un intermédiaire pour la mise en relation
 * initiale : on utilise le courtier public de PeerJS, qui ne voit transiter
 * que l'identifiant de la partie. Une fois la liaison établie, les coups
 * passent de navigateur à navigateur. Le site peut donc rester entièrement
 * statique (GitHub Pages, hébergement mutualisé…).
 *
 * La table est une étoile : chaque invité n'est relié qu'à l'hôte, qui fait
 * autorité — il détient le sac et tous les chevalets, valide les coups,
 * diffuse l'état et relaie les messages du tchat. Les invités n'envoient que
 * des intentions et ne se parlent jamais directement : à quatre, cela fait
 * trois liaisons au lieu de six, et une seule version de la vérité.
 */
import Peer from 'peerjs';

/** Préfixe des identifiants, pour ne pas croiser d'autres applications. */
const PREFIX = 'centurion-scrabble-';

/** Alphabet sans caractères ambigus : ni I/1, ni O/0. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Délai au-delà duquel on considère la mise en relation perdue. */
const CONNECT_TIMEOUT_MS = 20000;

/**
 * Attentes successives avant de retenter une liaison rompue. Un onglet mis
 * en arrière-plan par le téléphone perd sa liaison sans que la partie soit
 * finie pour autant : on rappelle, de plus en plus espacé.
 */
const RESUME_DELAYS_MS = [800, 1500, 3000, 6000, 10000, 15000];

/** Au-delà, on cesse d'espérer et la partie est déclarée perdue. */
const MAX_RESUME_ATTEMPTS = 20;

/** Invités simultanés qu'un hôte peut accueillir, lui non compris. */
export const MAX_GUESTS = 3;

/** Clé du jeton qui permet à un invité de retrouver son siège. */
const TOKEN_KEY = 'centurion-scrabble/jeton';

/**
 * Jeton stable propre à ce navigateur.
 *
 * Une reconnexion ouvre une liaison neuve, avec un identifiant PeerJS neuf :
 * sans ce jeton, l'hôte prendrait le revenant pour un cinquième joueur et le
 * refuserait, alors que sa place l'attend. Le jeton survit à la fermeture de
 * l'onglet ; à défaut de stockage, il vaut pour la session.
 */
let sessionToken = null;
export function myToken() {
  if (sessionToken) return sessionToken;
  try {
    const kept = localStorage.getItem(TOKEN_KEY);
    if (kept) {
      sessionToken = kept;
      return sessionToken;
    }
  } catch {
    /* stockage indisponible : le jeton ne vaudra que pour cette session */
  }
  sessionToken = makeCode() + makeCode();
  try {
    localStorage.setItem(TOKEN_KEY, sessionToken);
  } catch {
    /* stockage indisponible : tant pis, la reprise en pâtira */
  }
  return sessionToken;
}

export function makeCode() {
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  return [...values].map((n) => ALPHABET[n % ALPHABET.length]).join('');
}

export function normalizeCode(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/** Lien à transmettre à l'adversaire pour rejoindre une partie. */
export function inviteLink(code) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#partie=${code}`;
}

/** Code présent dans l'adresse, le cas échéant. */
export function codeFromLocation() {
  const match = /[#&?]partie=([A-Za-z0-9]+)/.exec(window.location.hash);
  return match ? normalizeCode(match[1]) : null;
}

export function clearLocationCode() {
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

/**
 * Une session réseau : un hôte et jusqu'à trois invités.
 *
 * Événements attendus dans `handlers` :
 *   onStatus(texte)       — message d'avancement destiné à l'écran
 *   onReady(code)         — l'hôte est joignable
 *   onConnected(id)       — une liaison s'est ouverte (id : l'invité, côté hôte)
 *   onData(message, id)   — message reçu (id : l'invité qui l'envoie)
 *   onGuestGone(id)       — un invité a quitté la liaison (hôte seulement)
 *   onDropped(raison)     — liaison rompue, reprise en cours
 *   onResumed()           — liaison rétablie après une coupure
 *   onClosed(raison)      — liaison rompue sans retour possible
 *   onError(message)      — échec définitif
 */
export class PeerSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.peer = null;
    /** Côté invité : l'unique liaison vers l'hôte. */
    this.conn = null;
    /** Côté hôte : une liaison par invité, indexée par son identifiant. */
    this.conns = new Map();
    this.role = null; // 'host' | 'guest'
    this.code = null;
    this.closing = false;
    this.timer = null;
    this.resumeTimer = null;
    this.attempts = 0;
    this.resuming = false;
    /** Places encore ouvertes à la table, hôte non compris. */
    this.capacity = MAX_GUESTS;
  }

  get connected() {
    if (this.role === 'host') return this.openConns().length > 0;
    return Boolean(this.conn?.open);
  }

  /** Liaisons effectivement ouvertes, côté hôte. */
  openConns() {
    return [...this.conns.values()].filter((conn) => conn.open);
  }

  get guestCount() {
    return this.openConns().length;
  }

  /** Liaison coupée mais pas abandonnée : une reprise est en cours. */
  get reconnecting() {
    return Boolean(this.role) && !this.connected && !this.closing;
  }

  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  /* ---------------------------------------------------------------- */

  /**
   * Ouvre une partie et attend des adversaires.
   * @param {number} attempt réservé aux reprises après collision d'identifiant
   */
  host(attempt = 0, resume = false) {
    const previous = this.code;
    const capacity = this.capacity;
    this.destroy();
    this.closing = false;
    this.resuming = resume;
    this.role = 'host';
    // Une reprise garde le code : le lien déjà transmis à l'adversaire doit
    // continuer de mener à cette partie.
    this.code = resume && previous ? previous : makeCode();
    // `destroy` a remis la capacité par défaut : on restitue celle choisie.
    this.capacity = capacity;
    if (!resume) this.attempts = 0;
    this.emit('onStatus', resume ? 'Rétablissement de la partie…' : 'Ouverture de la partie…');

    const peer = new Peer(PREFIX + this.code, { debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      this.emit('onReady', this.code);
      this.emit('onStatus', 'En attente des autres joueurs…');
    });

    peer.on('connection', (conn) => {
      // La table a un nombre de places fini : au-delà, on refuse poliment.
      // Le revenant, lui, est reconnu plus haut dans la pile — à son jeton —
      // et l'hôte lui rend sa place sans qu'elle compte pour une nouvelle.
      if (this.guestCount >= this.capacity) {
        conn.on('open', () => {
          conn.send({ t: 'busy' });
          setTimeout(() => conn.close(), 200);
        });
        return;
      }
      this.attachGuest(conn);
    });

    peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        // En reprise, l'identifiant occupé est le nôtre : il se libère de
        // lui-même, il suffit d'attendre. À l'ouverture, on en tire un autre.
        if (resume) {
          this.scheduleResume();
          return;
        }
        if (attempt < 4) {
          this.host(attempt + 1);
          return;
        }
      }
      if (this.resuming) {
        this.scheduleResume();
        return;
      }
      this.fail(error);
    });

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });

    // Le pair a été fermé par le service : on se réinscrit sous le même code.
    peer.on('close', () => {
      if (!this.closing) this.scheduleResume();
    });
  }

  /** Rejoint une partie à partir de son code. */
  join(rawCode, resume = false) {
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH) {
      this.emit('onError', 'Ce code de partie est incomplet.');
      return;
    }

    this.destroy();
    this.closing = false;
    this.resuming = resume;
    this.role = 'guest';
    this.code = code;
    if (!resume) this.attempts = 0;
    this.emit('onStatus', resume ? 'Reconnexion à la partie…' : 'Connexion à la partie…');

    const peer = new Peer({ debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      this.attachHost(conn);

      this.timer = setTimeout(() => {
        if (this.connected) return;
        // En reprise, l'hôte absent n'est pas une fin : son onglet peut
        // revenir, et le code reste valable.
        if (this.resuming) {
          this.scheduleResume();
          return;
        }
        this.emit('onError', 'Aucune réponse : la partie est peut-être fermée.');
        this.destroy();
      }, CONNECT_TIMEOUT_MS);
    });

    peer.on('error', (error) => {
      if (this.resuming) {
        this.scheduleResume();
        return;
      }
      this.fail(error);
    });

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });

    peer.on('close', () => {
      if (!this.closing) this.scheduleResume();
    });
  }

  /* ---------------------------------------------------------------- */

  /** Retente la liaison, en espaçant les essais. */
  scheduleResume() {
    if (this.closing || !this.role) return;
    if (this.attempts >= MAX_RESUME_ATTEMPTS) {
      this.emit('onClosed', 'Liaison perdue : la partie n’a pas pu être reprise.');
      this.destroy();
      return;
    }
    const delay = RESUME_DELAYS_MS[Math.min(this.attempts, RESUME_DELAYS_MS.length - 1)];
    this.attempts++;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.resumeNow(), delay);
  }

  /**
   * Reprend la liaison sans attendre l'essai programmé — au retour dans
   * l'onglet, par exemple, où l'on sait déjà que le téléphone nous rend la
   * main.
   */
  resumeNow() {
    if (this.closing || this.connected || !this.role) return;
    clearTimeout(this.resumeTimer);
    const role = this.role;
    const code = this.code;
    if (role === 'guest') this.join(code, true);
    else this.host(0, true);
  }

  /* ---------------------------------------------------------------- */

  /** Côté invité : l'unique liaison, celle qui mène à l'hôte. */
  attachHost(conn) {
    this.conn = conn;

    conn.on('open', () => {
      clearTimeout(this.timer);
      const reprise = this.resuming;
      this.resuming = false;
      this.attempts = 0;
      this.emit('onConnected');
      if (reprise) this.emit('onResumed');
    });

    conn.on('data', (message) => {
      if (message && typeof message === 'object') this.emit('onData', message);
    });

    conn.on('close', () => {
      if (this.closing) return;
      this.conn = null;
      // L'hôte a pu simplement passer en arrière-plan : on le rappelle.
      this.emit('onDropped', 'Liaison interrompue. Reprise en cours…');
      this.scheduleResume();
    });

    conn.on('error', () => {
      if (!this.closing) this.emit('onDropped', 'La liaison a été interrompue.');
    });
  }

  /**
   * Côté hôte : une liaison parmi d'autres.
   *
   * Chacune vit sa vie — l'une peut tomber sans rien changer aux autres, et
   * la partie continue autour du joueur absent, qui retrouvera sa place au
   * retour. C'est pourquoi rien n'est démonté ici sur une fermeture : on se
   * contente de signaler qui vient de partir.
   */
  attachGuest(conn) {
    const id = conn.peer;
    this.conns.set(id, conn);

    conn.on('open', () => {
      this.emit('onConnected', id);
    });

    conn.on('data', (message) => {
      if (message && typeof message === 'object') this.emit('onData', message, id);
    });

    conn.on('close', () => {
      if (this.closing) return;
      this.conns.delete(id);
      this.emit('onGuestGone', id);
    });

    conn.on('error', () => {
      if (this.closing) return;
      this.conns.delete(id);
      this.emit('onGuestGone', id);
    });
  }

  fail(error) {
    clearTimeout(this.timer);
    const messages = {
      'peer-unavailable': 'Partie introuvable : vérifiez le code, ou l’hôte a fermé son onglet.',
      'unavailable-id': 'Impossible d’ouvrir la partie, réessayez.',
      'browser-incompatible': 'Ce navigateur ne gère pas les connexions directes.',
      network: 'Connexion au service de mise en relation impossible.',
      'server-error': 'Le service de mise en relation ne répond pas.',
      'socket-error': 'Le service de mise en relation ne répond pas.',
      'ssl-unavailable': 'Connexion sécurisée refusée par le service de mise en relation.',
    };
    this.emit('onError', messages[error?.type] ?? 'La connexion a échoué.');
    this.destroy();
  }

  /** Côté invité : vers l'hôte. Côté hôte : vers tout le monde. */
  send(message) {
    if (this.role === 'host') {
      for (const conn of this.openConns()) conn.send(message);
      return;
    }
    if (this.conn?.open) this.conn.send(message);
  }

  /** Côté hôte : à un invité en particulier — son instantané, son refus. */
  sendTo(id, message) {
    const conn = this.conns.get(id);
    if (conn?.open) conn.send(message);
  }

  /** Côté hôte : à tous sauf un — le relais d'un message de tchat. */
  sendExcept(id, message) {
    for (const conn of this.openConns()) {
      if (conn.peer !== id) conn.send(message);
    }
  }

  destroy() {
    this.closing = true;
    clearTimeout(this.timer);
    clearTimeout(this.resumeTimer);
    try {
      this.conn?.close();
    } catch {
      /* liaison déjà rompue */
    }
    for (const conn of this.conns.values()) {
      try {
        conn.close();
      } catch {
        /* liaison déjà rompue */
      }
    }
    try {
      this.peer?.destroy();
    } catch {
      /* pair déjà détruit */
    }
    this.conn = null;
    this.conns.clear();
    this.capacity = MAX_GUESTS;
    this.peer = null;
  }
}
