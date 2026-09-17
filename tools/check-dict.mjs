#!/usr/bin/env node
/**
 * Vérifie que le DAWG sérialisé contient exactement le lexique attendu :
 * énumération complète de l'automate, comparée au jeu de mots d'origine.
 *
 *   node tools/check-dict.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Dawg } from '../src/core/dawg.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const raw = readFileSync(join(ROOT, 'public', 'dict', 'fr.dawg'));
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const dawg = new Dawg(buffer);

console.log(`Déclaré   : ${dawg.wordCount} mots, ${dawg.edgeCount} arêtes`);

/** Énumère tous les mots de l'automate. */
function enumerate(dawg) {
  const words = new Set();
  const walk = (node, prefix) => {
    if (node === 0) return;
    for (let edge = node; edge < dawg.edgeCount; edge++) {
      const word = prefix + String.fromCharCode(65 + dawg.letterAt(edge));
      if (dawg.isWordEnd(edge)) words.add(word);
      walk(dawg.child(edge), word);
      if (dawg.isLast(edge)) break;
    }
  };
  walk(dawg.root, '');
  return words;
}

const enumerated = enumerate(dawg);
console.log(`Énumérés  : ${enumerated.size} mots`);

// Jeu de référence, reconstruit avec la même normalisation que le build.
const source = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'an-array-of-french-words', 'index.json'), 'utf8'),
);
const expected = new Set();
for (const entry of source) {
  const word = entry.trim();
  if (!word || word[0] !== word[0].toLocaleLowerCase('fr')) continue;
  const folded = word
    .toLocaleLowerCase('fr')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
  if (/^[A-Z]{2,15}$/.test(folded)) expected.add(folded);
}

let missing = 0;
for (const word of expected) if (!enumerated.has(word)) missing++;
let extra = 0;
for (const word of enumerated) if (!expected.has(word)) extra++;

console.log(`Attendus  : ${expected.size} mots`);
console.log(`Manquants : ${missing}   En trop : ${extra}`);

// Vérification du chemin de recherche utilisé en jeu (has()), pas seulement
// de l'énumération.
const probes = [...expected].slice(0, 20000);
let lookupFailures = 0;
for (const word of probes) if (!dawg.has(word)) lookupFailures++;

const negatives = ['XYZZY', 'BLURP', 'ZZZZ', 'QWERTY', 'AZERTYU', 'MAISONZ', 'A', 'ZZ'];
const falsePositives = negatives.filter((w) => dawg.has(w));

console.log(`Recherche : ${probes.length} sondes, ${lookupFailures} échecs`);
console.log(`Faux positifs : ${falsePositives.length ? falsePositives.join(', ') : 'aucun'}`);

const ok = missing === 0 && extra === 0 && lookupFailures === 0 && falsePositives.length === 0;
console.log(ok ? '\n✅ Dictionnaire conforme.' : '\n❌ Incohérence détectée.');
process.exit(ok ? 0 : 1);
