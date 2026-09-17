/**
 * Lecture du dictionnaire binaire produit par `tools/build-dict.mjs`.
 *
 * Le fichier est un tableau d'arêtes de 32 bits :
 *   bits  0..4   index de lettre (A=0 … Z=25)
 *   bit   5      un mot se termine sur cette arête
 *   bit   6      dernière arête du nœud
 *   bits  7..31  offset de la première arête du nœud fils (0 = feuille)
 *
 * Un « nœud » est simplement l'offset de sa première arête ; ses arêtes sont
 * contiguës, triées par lettre, et la dernière porte le bit 6.
 */

const MAGIC = 0x43534431; // "CSD1"

export const LETTER_END = 1 << 5;
export const LETTER_LAST = 1 << 6;

export class Dawg {
  /** @param {ArrayBuffer} buffer */
  constructor(buffer) {
    const header = new Uint32Array(buffer, 0, 4);
    if (header[0] !== MAGIC) throw new Error('Dictionnaire illisible : en-tête inattendu.');
    this.edgeCount = header[1];
    this.root = header[2];
    this.wordCount = header[3];
    this.edges = new Uint32Array(buffer, 16, this.edgeCount);
  }

  /** @param {string} url */
  static async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Dictionnaire introuvable (${response.status}).`);
    return new Dawg(await response.arrayBuffer());
  }

  letterAt(edge) {
    return this.edges[edge] & 31;
  }

  isWordEnd(edge) {
    return (this.edges[edge] & LETTER_END) !== 0;
  }

  isLast(edge) {
    return (this.edges[edge] & LETTER_LAST) !== 0;
  }

  /** Nœud atteint en franchissant cette arête (0 s'il n'y a pas de suite). */
  child(edge) {
    return this.edges[edge] >>> 7;
  }

  /**
   * Cherche l'arête d'un nœud portant une lettre donnée.
   * @returns {number} index de l'arête, ou -1
   */
  edgeFor(node, letterIndex) {
    if (node === 0) return -1;
    for (let edge = node; edge < this.edgeCount; edge++) {
      const letter = this.edges[edge] & 31;
      if (letter === letterIndex) return edge;
      if (letter > letterIndex) return -1; // arêtes triées
      if ((this.edges[edge] & LETTER_LAST) !== 0) return -1;
    }
    return -1;
  }

  /**
   * Masque des lettres praticables depuis un nœud (bit 0 = A … bit 25 = Z).
   */
  letterMask(node) {
    if (node === 0) return 0;
    let mask = 0;
    for (let edge = node; edge < this.edgeCount; edge++) {
      mask |= 1 << (this.edges[edge] & 31);
      if ((this.edges[edge] & LETTER_LAST) !== 0) break;
    }
    return mask;
  }

  /**
   * Suit une suite de lettres depuis un nœud.
   * @returns {number} nœud atteint, ou -1 si le chemin n'existe pas
   */
  walk(node, letterIndices) {
    let current = node;
    for (const letterIndex of letterIndices) {
      const edge = this.edgeFor(current, letterIndex);
      if (edge < 0) return -1;
      current = this.child(edge);
    }
    return current;
  }

  /**
   * Suit une suite de lettres et indique si elle forme un mot complet.
   * @returns {{node: number, terminal: boolean}|null}
   */
  walkWithTerminal(node, letterIndices) {
    let current = node;
    let terminal = false;
    for (const letterIndex of letterIndices) {
      const edge = this.edgeFor(current, letterIndex);
      if (edge < 0) return null;
      terminal = this.isWordEnd(edge);
      current = this.child(edge);
    }
    return { node: current, terminal };
  }

  /** @param {number[]} letterIndices */
  hasIndices(letterIndices) {
    if (letterIndices.length < 2) return false;
    const result = this.walkWithTerminal(this.root, letterIndices);
    return result !== null && result.terminal;
  }

  /** @param {string} word — en majuscules non accentuées */
  has(word) {
    if (word.length < 2) return false;
    const indices = [];
    for (let i = 0; i < word.length; i++) {
      const code = word.charCodeAt(i) - 65;
      if (code < 0 || code > 25) return false;
      indices.push(code);
    }
    return this.hasIndices(indices);
  }
}
