#!/usr/bin/env node
/**
 * Construit le dictionnaire binaire (DAWG) utilisé par le jeu.
 *
 *   npm run build:dict                  → lexique libre embarqué (par défaut)
 *   npm run build:dict -- mon-ods.txt   → fichier perso, un mot par ligne
 *
 * Les fichiers `data/supplement.txt` (mots ajoutés) et `data/exclusions.txt`
 * (mots retirés) sont appliqués dans tous les cas s'ils existent.
 *
 * Sortie : public/dict/fr.dawg + public/dict/fr.meta.json
 *
 * Le fichier est écrit tel quel, sans compression : les serveurs ajoutent
 * `Content-Encoding: gzip` d'eux-mêmes sur une extension `.gz`, ce que le
 * navigateur défait avant que le script n'y touche. La compression de
 * transport est laissée au serveur (voir public/.htaccess).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'dict');

/* ------------------------------------------------------------------ */
/* 1. Normalisation « scrabblesque »                                   */
/* ------------------------------------------------------------------ */

/**
 * Un mot jouable au Scrabble francophone : 2 à 15 lettres de A à Z, sans
 * signe diacritique (les accents sont ignorés sur le plateau), sans trait
 * d'union ni apostrophe, et qui n'est pas un nom propre.
 */
function normalize(raw) {
  const word = raw.trim();
  if (!word) return null;
  // Un nom propre est capitalisé dans la source : on l'écarte avant de
  // passer en majuscules.
  if (word[0] !== word[0].toLocaleLowerCase('fr')) return null;

  const folded = word
    .toLocaleLowerCase('fr')
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();

  if (!/^[A-Z]{2,15}$/.test(folded)) return null;
  return folded;
}

function loadLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/);
}

/* ------------------------------------------------------------------ */
/* 2. Collecte du lexique                                              */
/* ------------------------------------------------------------------ */

async function collectWords() {
  const custom = process.argv[2];
  let source;
  let raw;

  if (custom) {
    const path = resolve(process.cwd(), custom);
    raw = loadLines(path);
    source = `fichier personnalisé (${custom})`;
  } else {
    // Le paquet expose un simple index.json : on le lit tel quel plutôt que
    // de dépendre des attributs d'import JSON.
    const path = join(ROOT, 'node_modules', 'an-array-of-french-words', 'index.json');
    raw = JSON.parse(readFileSync(path, 'utf8'));
    source = 'an-array-of-french-words (MIT, dérivé de Dicollecte)';
  }

  const words = new Set();
  for (const entry of raw) {
    const w = normalize(entry);
    if (w) words.add(w);
  }
  const base = words.size;

  let added = 0;
  const supplement = join(ROOT, 'data', 'supplement.txt');
  if (existsSync(supplement)) {
    for (const entry of loadLines(supplement)) {
      if (entry.startsWith('#')) continue;
      const w = normalize(entry);
      if (w && !words.has(w)) {
        words.add(w);
        added++;
      }
    }
  }

  let removed = 0;
  const exclusions = join(ROOT, 'data', 'exclusions.txt');
  if (existsSync(exclusions)) {
    for (const entry of loadLines(exclusions)) {
      if (entry.startsWith('#')) continue;
      const w = normalize(entry);
      if (w && words.delete(w)) removed++;
    }
  }

  return { words: [...words].sort(), source, base, added, removed };
}

/* ------------------------------------------------------------------ */
/* 3. Construction du DAWG minimal (Daciuk et al., incrémental)        */
/* ------------------------------------------------------------------ */

let nodeCounter = 0;

class Node {
  constructor() {
    this.id = ++nodeCounter;
    this.final = false;
    this.edges = new Map(); // lettre → Node
  }

  /** Signature d'équivalence : deux nœuds de même signature sont fusionnés. */
  signature() {
    let s = this.final ? '1' : '0';
    for (const [letter, child] of this.edges) s += `|${letter}${child.id}`;
    return s;
  }
}

function buildDawg(sortedWords) {
  const root = new Node();
  const register = new Map();
  /** @type {[Node, string, Node][]} */
  const unchecked = [];
  let previous = '';

  const minimize = (downTo) => {
    for (let i = unchecked.length - 1; i >= downTo; i--) {
      const [parent, letter, child] = unchecked[i];
      const sig = child.signature();
      const existing = register.get(sig);
      if (existing) parent.edges.set(letter, existing);
      else register.set(sig, child);
      unchecked.pop();
    }
  };

  for (const word of sortedWords) {
    let i = 0;
    const max = Math.min(word.length, previous.length);
    while (i < max && word[i] === previous[i]) i++;

    minimize(i);

    let node = unchecked.length === 0 ? root : unchecked[unchecked.length - 1][2];
    for (; i < word.length; i++) {
      const child = new Node();
      node.edges.set(word[i], child);
      unchecked.push([node, word[i], child]);
      node = child;
    }
    node.final = true;
    previous = word;
  }
  minimize(0);

  return root;
}

/* ------------------------------------------------------------------ */
/* 4. Sérialisation : un Uint32 par arête                              */
/* ------------------------------------------------------------------ */
/*
 *   bits  0..4   index de lettre (A=0 … Z=25)
 *   bit   5      le mot se termine sur cette arête
 *   bit   6      dernière arête du nœud
 *   bits  7..31  offset de la première arête du nœud fils (0 = feuille)
 *
 *   L'emplacement 0 est réservé pour que l'offset 0 signifie « pas de fils ».
 */

const CODE_A = 'A'.charCodeAt(0);

function serialize(root) {
  const offsets = new Map();
  const order = [];

  // Parcours itératif : on collecte tous les nœuds distincts ayant des arêtes.
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node) || node.edges.size === 0) continue;
    seen.add(node);
    order.push(node);
    for (const child of node.edges.values()) stack.push(child);
  }

  let cursor = 1; // l'emplacement 0 reste nul
  for (const node of order) {
    offsets.set(node, cursor);
    cursor += node.edges.size;
  }

  const edges = new Uint32Array(cursor);
  for (const node of order) {
    const letters = [...node.edges.keys()].sort();
    let slot = offsets.get(node);
    letters.forEach((letter, index) => {
      const child = node.edges.get(letter);
      let word = letter.charCodeAt(0) - CODE_A;
      if (child.final) word |= 1 << 5;
      if (index === letters.length - 1) word |= 1 << 6;
      const childOffset = offsets.get(child) ?? 0;
      word |= childOffset << 7;
      edges[slot++] = word;
    });
  }

  return { edges, rootOffset: offsets.get(root), nodeCount: order.length };
}

/* ------------------------------------------------------------------ */

const started = Date.now();
const { words, source, base, added, removed } = await collectWords();
console.log(`Lexique   : ${words.length} mots  (${source})`);
if (added || removed) console.log(`            +${added} supplément, −${removed} exclusions (base ${base})`);

const root = buildDawg(words);
const { edges, rootOffset, nodeCount } = serialize(root);

const header = new Uint32Array([0x43534431 /* "CSD1" */, edges.length, rootOffset, words.length]);
const payload = new Uint8Array(header.byteLength + edges.byteLength);
payload.set(new Uint8Array(header.buffer), 0);
payload.set(new Uint8Array(edges.buffer), header.byteLength);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'fr.dawg'), payload);
writeFileSync(
  join(OUT_DIR, 'fr.meta.json'),
  JSON.stringify({ source, words: words.length, nodes: nodeCount, edges: edges.length, builtAt: new Date().toISOString() }, null, 2),
);

const kb = (n) => `${(n / 1024).toFixed(0)} Ko`;
console.log(`DAWG      : ${nodeCount} nœuds, ${edges.length} arêtes`);
console.log(`Sortie    : ${kb(payload.length)} (≈ ${kb(payload.length * 0.6)} une fois compressé par le serveur)`);
console.log(`Terminé en ${((Date.now() - started) / 1000).toFixed(1)} s`);
