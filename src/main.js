import './styles.css';
import { Dawg } from './core/dawg.js';
import { App } from './ui/app.js';

const BASE = import.meta.env.BASE_URL;

async function loadDictionary() {
  const response = await fetch(`${BASE}dict/fr.dawg`);
  if (!response.ok) throw new Error(`dictionnaire introuvable (${response.status})`);
  return response.arrayBuffer();
}

async function loadMeta() {
  try {
    const response = await fetch(`${BASE}dict/fr.meta.json`);
    return response.ok ? await response.json() : { words: 0, source: 'inconnue' };
  } catch {
    return { words: 0, source: 'inconnue' };
  }
}

async function start() {
  const loader = document.getElementById('loader');

  try {
    const [buffer, meta] = await Promise.all([loadDictionary(), loadMeta()]);
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
