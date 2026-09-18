#!/usr/bin/env node
/**
 * Récupère le lexique de base du jeu :
 *
 *   npm run dict:fetch
 *
 * La source est Morphalou 3.1 (ATILF/CNRS), sous LGPL-LR, dans la version
 * déjà filtrée pour le jeu par le dépôt `french-fr-fr-morphalou` : formes
 * fléchies conservées, abréviations, variantes liées, locutions, majuscules
 * et symboles d'unités écartés.
 *
 * Le dépôt n'embarque pas les 8,9 Mo de la liste ; il embarque sa
 * provenance. Le commit et l'empreinte ci-dessous sont figés, et le script
 * refuse tout contenu qui ne leur correspond pas : le lexique servi aux
 * joueurs est ainsi reproductible sans alourdir l'historique.
 *
 * Sortie : data/morphalou-strict.txt (ignoré par git), consommé ensuite par
 * `npm run build:dict`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Source figée. Voir `docs` du dépôt amont pour la chaîne de filtrage. */
const SOURCE = {
  repository: 'https://github.com/FredrikBorgstrom/french-fr-fr-morphalou',
  commit: 'a020006f61bddbef60353f4ae19534714df899fe',
  path: 'output/french_fr_fr_morphalou_strict.txt',
  // Empreinte relevée sur le fichier livré à ce commit. Elle diffère de
  // celle inscrite dans l'`audit.json` amont, qui n'a pas été régénérée
  // avec la liste (4 mots d'écart) : on épingle ce qui est réellement
  // servi, pas ce qui est annoncé.
  sha256: 'e9d028c0be53b61c9a61dd576640ec4bcde1acd6ec5a59dceece8561d3d5a48b',
  words: 727858,
};

const TARGET = join(ROOT, 'data', 'morphalou-strict.txt');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

if (existsSync(TARGET) && sha256(TARGET) === SOURCE.sha256) {
  console.log(`Lexique   : déjà présent et conforme (${TARGET})`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'morphalou-'));
try {
  console.log(`Source    : ${SOURCE.repository}`);
  console.log(`Commit    : ${SOURCE.commit}`);

  // Un fetch du seul commit épinglé : ni l'historique ni la branche amont
  // n'entrent en jeu, donc un déplacement de HEAD ne change pas le lexique.
  git(work, 'init', '--quiet');
  git(work, 'remote', 'add', 'origin', SOURCE.repository);
  git(work, 'fetch', '--quiet', '--depth', '1', 'origin', SOURCE.commit);
  git(work, 'checkout', '--quiet', 'FETCH_HEAD');

  const fetched = join(work, SOURCE.path);
  const digest = sha256(fetched);
  if (digest !== SOURCE.sha256) {
    console.error(`\nEmpreinte inattendue pour ${SOURCE.path} :`);
    console.error(`  attendu : ${SOURCE.sha256}`);
    console.error(`  obtenu  : ${digest}`);
    console.error('\nLe lexique n\'a pas été installé.');
    process.exit(1);
  }

  copyFileSync(fetched, TARGET);
  console.log(`Empreinte : ${digest.slice(0, 16)}… conforme`);
  console.log(`Sortie    : data/morphalou-strict.txt (${SOURCE.words} mots)`);
  console.log('\nEnchaînez avec `npm run build:dict`.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
