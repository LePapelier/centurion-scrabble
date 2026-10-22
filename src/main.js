import './styles.css';
import { Dawg } from './core/dawg.js';
import { App } from './ui/app.js';

const BASE = import.meta.env.BASE_URL;

/**
 * Le dictionnaire porte toujours le même nom et se met en cache pour un an
 * (voir public/.htaccess). Sans marqueur dans l'adresse, une correction du
 * lexique reste donc invisible pendant des mois sur un appareil qui a déjà
 * téléchargé le fichier — un mot rattrapé continue d'être refusé, un mot
 * écarté continue de passer.
 *
 * La date de construction, lue dans le manifeste, sert d'empreinte : chaque
 * reconstruction donne une adresse neuve, et le cache long redevient ce qu'il
 * doit être — une économie, pas un piège.
 */
async function loadDictionary(version) {
  const url = `${BASE}dict/fr.dawg${version ? `?v=${encodeURIComponent(version)}` : ''}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`dictionnaire introuvable (${response.status})`);
  return response.arrayBuffer();
}

/**
 * Le manifeste est demandé sans cache : quelques centaines d'octets à chaque
 * ouverture, contre un lexique qui resterait faux toute une année. Hors ligne
 * la requête échoue, on repart sans empreinte, et la copie déjà téléchargée
 * fait l'affaire.
 */
async function loadMeta() {
  try {
    const response = await fetch(`${BASE}dict/fr.meta.json`, { cache: 'no-cache' });
    return response.ok ? await response.json() : { words: 0, source: 'inconnue' };
  } catch {
    return { words: 0, source: 'inconnue' };
  }
}

/**
 * Le dictionnaire n'est lu qu'au chargement de la page. Sur un téléphone, où
 * l'onglet reste ouvert des jours, une correction du lexique ne parvient donc
 * jamais au joueur : il garde en mémoire la version qu'il avait en ouvrant le
 * jeu, et un mot écarté la veille continue de passer.
 *
 * À chaque retour sur la page, on redemande le manifeste — quelques centaines
 * d'octets, déjà exclus du cache — et on compare sa date à celle qu'on tient.
 * Si elle a changé, la page se recharge : c'est la seule façon sûre de tout
 * reprendre d'un coup, le dictionnaire du fil principal comme la copie du
 * worker. La partie en cours est enregistrée à chaque coup, elle revient
 * telle quelle.
 *
 * Le rechargement attend un moment sans risque : une partie solo, aucune
 * tuile posée en attente de validation, et pas de calcul en cours. En partie
 * à deux il n'a jamais lieu — recharger couperait la liaison WebRTC, et le
 * dictionnaire qui fait foi est de toute façon celui de l'hôte.
 */
function veillerSurLeDictionnaire(app, empreinte) {
  // Le manifeste est minuscule, mais rien ne presse : une correction peut
  // attendre le prochain quart d'heure.
  const REPOS = 15 * 60 * 1000;
  let dernierExamen = Date.now();
  let perime = false;
  let guet = null;

  const sansRisque = () => app.mode === 'solo' && !app.busy && app.pending.size === 0;

  const recharger = () => {
    if (!sansRisque()) return;
    clearInterval(guet);
    try {
      sessionStorage.setItem(MAJ_KEY, '1');
    } catch {
      /* stockage refusé : on rechargera sans le dire */
    }
    location.reload();
  };

  const examiner = async () => {
    if (perime) return recharger();
    if (document.hidden || Date.now() - dernierExamen < REPOS) return;
    dernierExamen = Date.now();
    const meta = await loadMeta();
    if (!meta.builtAt || meta.builtAt === empreinte) return;
    perime = true;
    // Le moment n'est peut-être pas venu — on guette, sans plus rien demander
    // au réseau.
    guet = setInterval(recharger, 20000);
    recharger();
  };

  document.addEventListener('visibilitychange', examiner);
  window.addEventListener('focus', examiner);
}

/** Marque posée avant un rechargement, pour en dire un mot au retour. */
const MAJ_KEY = 'centurion:dict-maj';

async function start() {
  const loader = document.getElementById('loader');

  try {
    // Le manifeste d'abord : c'est lui qui donne l'empreinte du dictionnaire.
    const meta = await loadMeta();
    const buffer = await loadDictionary(meta.builtAt);
    const dawg = new Dawg(buffer);

    const worker = new Worker(new URL('./workers/ai.worker.js', import.meta.url), { type: 'module' });
    await new Promise((resolve, reject) => {
      const onReady = (event) => {
        if (event.data?.type === 'ready') {
          worker.removeEventListener('message', onReady);
          resolve();
        }
      };
      worker.addEventListener('message', onReady);
      worker.addEventListener('error', reject, { once: true });
      // La structure est clonée : le fil principal garde la sienne pour
      // valider les coups du joueur sans aller-retour avec le worker.
      worker.postMessage({ type: 'init', buffer });
    });

    const app = new App({ dawg, worker, meta });
    app.mount();

    // Point d'entrée pour inspecter une partie depuis la console du navigateur.
    if (import.meta.env.DEV) window.__centurion = app;

    veillerSurLeDictionnaire(app, meta.builtAt);

    try {
      if (sessionStorage.getItem(MAJ_KEY)) {
        sessionStorage.removeItem(MAJ_KEY);
        app.toast('Dictionnaire mis à jour.');
      }
    } catch {
      /* stockage refusé : rien à dire */
    }

    loader.classList.add('done');
    setTimeout(() => loader.remove(), 350);
  } catch (error) {
    loader.innerHTML =
      '<div class="loader-tile">!</div><p>Impossible de charger le dictionnaire.<br />' +
      `<small>${String(error.message ?? error)}</small></p>`;
  }
}

start();
