/**
 * Liaison directe entre deux navigateurs, sans serveur applicatif.
 *
 * WebRTC exige tout de même un intermédiaire pour la mise en relation
 * initiale : on utilise le courtier public de PeerJS, qui ne voit transiter
 * que l'identifiant de la partie. Une fois la liaison établie, les coups
 * passent de navigateur à navigateur. Le site peut donc rester entièrement
 * statique (GitHub Pages, hébergement mutualisé…).
 *
 * L'hôte fait autorité : il détient le sac et les deux chevalets, valide les
 * coups et diffuse l'état. L'invité n'envoie que des intentions.
 */
import Peer from 'peerjs';

/** Préfixe des identifiants, pour ne pas croiser d'autres applications. */
const PREFIX = 'centurion-scrabble-';

/** Alphabet sans caractères ambigus : ni I/1, ni O/0. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Délai au-delà duquel on considère la mise en relation perdue. */
const CONNECT_TIMEOUT_MS = 20000;

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
 * Une session réseau : au plus un adversaire à la fois.
 *
 * Événements attendus dans `handlers` :
 *   onStatus(texte)       — message d'avancement destiné à l'écran
 *   onReady(code)         — l'hôte est joignable
 *   onConnected()         — les deux navigateurs se parlent
 *   onData(message)       — message reçu de l'adversaire
 *   onClosed(raison)      — liaison rompue
 *   onError(message)      — échec définitif
 */
export class PeerSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;
    this.role = null; // 'host' | 'guest'
    this.code = null;
    this.closing = false;
    this.timer = null;
  }

  get connected() {
    return Boolean(this.conn?.open);
  }

  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  /* ---------------------------------------------------------------- */

  /**
   * Ouvre une partie et attend un adversaire.
   * @param {number} attempt réservé aux reprises après collision d'identifiant
   */
  host(attempt = 0) {
    this.destroy();
    this.closing = false;
    this.role = 'host';
    this.code = makeCode();
    this.emit('onStatus', 'Ouverture de la partie…');

    const peer = new Peer(PREFIX + this.code, { debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      this.emit('onReady', this.code);
      this.emit('onStatus', 'En attente de votre adversaire…');
    });

    peer.on('connection', (conn) => {
      // Une partie se joue à deux : toute liaison supplémentaire est refusée.
      if (this.conn?.open) {
        conn.on('open', () => {
          conn.send({ t: 'busy' });
          setTimeout(() => conn.close(), 200);
        });
        return;
      }
      this.attach(conn);
    });

    peer.on('error', (error) => {
      // Identifiant déjà pris : on retente avec un autre code.
      if (error.type === 'unavailable-id' && attempt < 4) {
        this.host(attempt + 1);
        return;
      }
      this.fail(error);
    });

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });
  }

  /** Rejoint une partie à partir de son code. */
  join(rawCode) {
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH) {
      this.emit('onError', 'Ce code de partie est incomplet.');
      return;
    }

    this.destroy();
    this.closing = false;
    this.role = 'guest';
    this.code = code;
    this.emit('onStatus', 'Connexion à la partie…');

    const peer = new Peer({ debug: 0 });
    this.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      this.attach(conn);

      this.timer = setTimeout(() => {
        if (!this.connected) {
          this.emit('onError', 'Aucune réponse : la partie est peut-être fermée.');
          this.destroy();
        }
      }, CONNECT_TIMEOUT_MS);
    });

    peer.on('error', (error) => this.fail(error));

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });
  }

  /* ---------------------------------------------------------------- */

  attach(conn) {
    this.conn = conn;

    conn.on('open', () => {
      clearTimeout(this.timer);
      this.emit('onConnected');
    });

    conn.on('data', (message) => {
      if (message && typeof message === 'object') this.emit('onData', message);
    });

    conn.on('close', () => {
      if (this.closing) return;
      this.conn = null;
      this.emit('onClosed', 'Votre adversaire a quitté la partie.');
    });

    conn.on('error', () => {
      if (!this.closing) this.emit('onClosed', 'La liaison a été interrompue.');
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

  send(message) {
    if (this.conn?.open) this.conn.send(message);
  }

  destroy() {
    this.closing = true;
    clearTimeout(this.timer);
    try {
      this.conn?.close();
    } catch {
      /* liaison déjà rompue */
    }
    try {
      this.peer?.destroy();
    } catch {
      /* pair déjà détruit */
    }
    this.conn = null;
    this.peer = null;
  }
}
