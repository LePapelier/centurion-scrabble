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

    loader.classList.add('done');
    setTimeout(() => loader.remove(), 350);
  } catch (error) {
    loader.innerHTML =
      '<div class="loader-tile">!</div><p>Impossible de charger le dictionnaire.<br />' +
      `<small>${String(error.message ?? error)}</small></p>`;
  }
}

start();
