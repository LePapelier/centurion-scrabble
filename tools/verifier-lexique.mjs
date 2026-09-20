#!/usr/bin/env node
/**
 * Confronte le lexique du jeu à 1mot.net, mot par mot.
 *
 *   node tools/verifier-lexique.mjs                  → 2 à 5 lettres (~3 h 30)
 *   node tools/verifier-lexique.mjs --max=6          → jusqu'à 6 lettres (~9 h)
 *   node tools/verifier-lexique.mjs --suspects       → seulement les douteux
 *   node tools/verifier-lexique.mjs --exclusions     → relit ce qu'on a écarté
 *   node tools/verifier-lexique.mjs --simuler        → sans réseau, pour essayer
 *
 * Pourquoi pas tout le lexique : 642 000 mots à une requête par seconde font
 * sept jours, et autant de requêtes sur le site de quelqu'un d'autre. Les
 * mots courts suffisent — c'est là que vit le lexique de compétition, et
 * c'est là que les erreurs se rencontrent en jouant.
 *
 * Deux directions, car les deux erreurs existent :
 *   — ce que le jeu accepte et que la compétition refuse (RAMPIN, PREMIC) ;
 *   — ce que le jeu refuse et que la compétition accepte (--exclusions,
 *     pour relire nos propres exclusions).
 *
 * Le script n'écrit jamais dans le dictionnaire. Il produit un rapport, à
 * relire avant de reporter quoi que ce soit : une erreur d'analyse effacerait
 * sinon des mots justes en silence.
 *
 * Il est poli et reprenable : une pause entre deux requêtes, un cache sur
 * disque qui évite de redemander ce qu'on sait déjà, et un arrêt propre au
 * Ctrl-C qui sauvegarde. Relancé, il repart où il s'était arrêté.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dawg } from '../src/core/dawg.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'data', 'verifications.json');
const RAPPORT = join(ROOT, 'data', 'rapport-verification.txt');

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const opt = (nom, defaut) => {
  const trouve = args.find((a) => a.startsWith(`--${nom}=`));
  return trouve ? trouve.split('=')[1] : defaut;
};
const drapeau = (nom) => args.includes(`--${nom}`);

const MIN = Number(opt('min', 2));
const MAX = Number(opt('max', 5));
const PAUSE = Number(opt('pause', 1000));
const LIMITE = Number(opt('limite', Infinity));
/* Budget de temps, pour une exécution surveillée par une horloge — un job
   d'intégration continue est coupé net au bout de six heures, et un arrêt
   net perdrait le cache non sauvegardé. */
const MINUTES = Number(opt('minutes', Infinity));
const SUSPECTS = drapeau('suspects');
const EXCLUSIONS = drapeau('exclusions');
const SIMULER = drapeau('simuler');

/* ------------------------------------------------------------------ */
/* Ce qu'il y a à vérifier                                             */
/* ------------------------------------------------------------------ */

const plier = (w) => w.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

function motsDuDictionnaire() {
  const b = readFileSync(join(ROOT, 'public', 'dict', 'fr.dawg'));
  const d = new Dawg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const A = 65;
  const out = [];
  (function parcourir(node, prefixe) {
    if (node === 0) return;
    for (let e = node; e < d.edgeCount; e++) {
      const mot = prefixe + String.fromCharCode(A + d.letterAt(e));
      if (d.isWordEnd(e)) out.push(mot);
      parcourir(d.child(e), mot);
      if (d.isLast(e)) break;
    }
  })(d.root, '');
  return out;
}

function motsExclus() {
  const p = join(ROOT, 'data', 'exclusions.txt');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .flatMap((l) => l.split(/\s+/))
    .map(plier)
    .filter((m) => /^[A-Z]{2,15}$/.test(m));
}

function aVerifier() {
  if (EXCLUSIONS) {
    // Ici l'attendu est « invalide » : on cherche ce qu'on a écarté à tort.
    const mots = [...new Set(motsExclus())].filter((m) => m.length >= MIN && m.length <= MAX);
    return { mots, attendu: 'invalide', quoi: `${mots.length} exclusions` };
  }

  let mots = motsDuDictionnaire().filter((m) => m.length >= MIN && m.length <= MAX);
  let quoi = `${mots.length} mots de ${MIN} à ${MAX} lettres`;

  if (SUSPECTS) {
    // Les entrées que Morphalou porte seul : c'est de là que sortaient
    // PREMIC, IWAN, HUIR et RAMPIN. Rendement bien meilleur, volume bien
    // moindre — mais on y perd les erreurs que les deux lexiques partagent,
    // comme MEN.
    const usuel = new Set(
      JSON.parse(readFileSync(join(ROOT, 'node_modules', 'an-array-of-french-words', 'index.json'), 'utf8')).map(plier),
    );
    mots = mots.filter((m) => !usuel.has(m));
    quoi = `${mots.length} mots douteux de ${MIN} à ${MAX} lettres`;
  }

  // Les plus courts d'abord : ce sont ceux qu'on rencontre le plus en jouant.
  mots.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { mots, attendu: 'valide', quoi };
}

/* ------------------------------------------------------------------ */
/* Le verdict d'un mot                                                 */
/* ------------------------------------------------------------------ */

/**
 * La page annonce son verdict dans son titre. Une absence de page vaut
 * « invalide » : le site couvre l'ODS, ce qu'il ignore ne s'y trouve pas.
 * Tout le reste — coupure, erreur serveur, page méconnaissable — reste
 * « inconnu » : on ne devine pas.
 *
 * Le titre, et lui seul. Le corps des pages cite des mots voisins avec leur
 * propre verdict : y chercher « n'est pas valide » rendrait invalide la page
 * d'un mot parfaitement valide, et le rapport proposerait d'écarter des mots
 * justes. C'est l'erreur qui coûte le plus cher ici.
 *
 * Le titre doit en outre nommer le mot demandé : une redirection ou une page
 * d'erreur habillée ne vaut pas verdict pour autre chose.
 */
function lireVerdict(html, code, mot) {
  if (code === 404) return 'invalide';
  if (code !== 200) return 'inconnu';

  const titre = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  // L'apostrophe du site est typographique ; on accepte les deux.
  const dit = titre.match(/Le mot\s+([A-Za-zÀ-ÿ]+)\s+(n['’]est pas valide|est valide)\s+au scrabble/i);
  if (!dit) return 'inconnu';
  if (plier(dit[1]) !== mot) return 'inconnu';
  return /^n/i.test(dit[2]) ? 'invalide' : 'valide';
}

/** Réponse de complaisance, pour éprouver la chaîne sans toucher au réseau. */
function simuler(mot) {
  const valide = mot.charCodeAt(0) % 7 !== 0;
  return {
    code: valide ? 200 : 404,
    html: valide ? `<title>Le mot ${mot} est valide au scrabble</title>` : 'Not found',
  };
}

async function demander(mot) {
  if (SIMULER) return simuler(mot);
  const stop = new AbortController();
  const minuteur = setTimeout(() => stop.abort(), 15000);
  try {
    const r = await fetch(`https://1mot.net/${mot.toLowerCase()}`, {
      signal: stop.signal,
      headers: {
        'User-Agent': 'centurion-scrabble/1.0 (vérification de lexique, usage personnel)',
        'Accept': 'text/html',
      },
    });
    return { code: r.status, html: r.status === 200 ? await r.text() : '' };
  } catch {
    return { code: 0, html: '' };
  } finally {
    clearTimeout(minuteur);
  }
}

/* ------------------------------------------------------------------ */

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const { mots, attendu, quoi } = aVerifier();
const restants = mots.filter((m) => !cache[m]);

console.log(`À vérifier : ${quoi}`);
console.log(`Déjà en cache : ${mots.length - restants.length}`);
console.log(`Restants : ${restants.length}` +
  (SIMULER ? '  (simulation, aucun accès réseau)' : `  — environ ${((restants.length * PAUSE) / 3600000).toFixed(1)} h à ${PAUSE} ms`));
if (Number.isFinite(MINUTES)) console.log(`Budget : ${MINUTES} min`);
console.log('Ctrl-C à tout moment : le travail déjà fait est conservé.\n');

const echeance = Number.isFinite(MINUTES) ? Date.now() + MINUTES * 60000 : Infinity;

let faits = 0;
let echecs = 0;
let arret = false;
process.on('SIGINT', () => {
  console.log('\nArrêt demandé — sauvegarde…');
  arret = true;
});

const sauver = () => {
  writeFileSync(CACHE, JSON.stringify(cache, null, 0));
  ecrireRapport();
};

function ecrireRapport() {
  const desaccords = mots.filter((m) => cache[m] && cache[m] !== 'inconnu' && cache[m] !== attendu);
  const inconnus = mots.filter((m) => cache[m] === 'inconnu');
  const vus = mots.filter((m) => cache[m]).length;

  const lignes = [
    `# Rapport de vérification — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `# Portée : ${quoi}`,
    `# Vérifiés : ${vus} / ${mots.length}`,
    '#',
    attendu === 'valide'
      ? '# Mots que le jeu accepte et que 1mot.net refuse. À reporter dans'
      : '# Mots que le jeu écarte et que 1mot.net accepte. À retirer de',
    attendu === 'valide' ? '# data/exclusions.txt après relecture.' : '# data/exclusions.txt après relecture.',
    '',
    ...desaccords,
    '',
    `# Sans verdict (${inconnus.length}) — à reprendre plus tard, le site n'a pas répondu`,
    ...inconnus.map((m) => `# ${m}`),
    '',
  ];
  writeFileSync(RAPPORT, lignes.join('\n'));
  return desaccords.length;
}

for (const mot of restants) {
  if (arret || faits >= LIMITE) break;
  if (Date.now() >= echeance) {
    console.log('\nBudget de temps épuisé — arrêt propre.');
    break;
  }

  const { code, html } = await demander(mot);
  const verdict = lireVerdict(html, code, mot);
  cache[mot] = verdict;
  faits++;

  if (verdict === 'inconnu') {
    echecs++;
    // Le site ne répond plus comme attendu : insister n'apporterait rien
    // et serait impoli. On s'arrête, le cache garde le travail fait.
    if (echecs >= 10 && echecs === faits) {
      console.log('\nDix réponses illisibles d’affilée — arrêt. Le site est peut-être indisponible.');
      break;
    }
  } else if (verdict !== attendu) {
    console.log(`  ⚠ ${mot} : ${verdict}`);
  }

  if (faits % 25 === 0) {
    const reste = ((restants.length - faits) * PAUSE) / 3600000;
    console.log(`${faits} / ${restants.length}  (${reste.toFixed(1)} h restantes)`);
    sauver();
  }
  if (!SIMULER && PAUSE) await new Promise((r) => setTimeout(r, PAUSE));
}

const trouves = ecrireRapport();
writeFileSync(CACHE, JSON.stringify(cache, null, 0));
console.log(`\n${faits} mots vérifiés, ${trouves} désaccords.`);
const vus = mots.filter((m) => cache[m]).length;
console.log(`Avancement : ${vus} / ${mots.length} (${((vus / mots.length) * 100).toFixed(1)} %)`);
if (process.env.GITHUB_OUTPUT) {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_OUTPUT,
    `desaccords=${trouves}\nverifies=${vus}\ntotal=${mots.length}\n`);
}
console.log(`Rapport : data/rapport-verification.txt`);
console.log(`Cache   : data/verifications.json  (relancer reprend où on en est)`);
