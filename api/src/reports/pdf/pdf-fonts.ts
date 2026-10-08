/**
 * 1-16D — polices standard PDF Helvetica et Helvetica-Bold (aucune police
 * embarquée), encodage `WinAnsiEncoding` (Windows-1252). Largeurs en
 * millièmes d'em, d'après les métriques AFM d'Adobe ; une lettre accentuée
 * a la largeur de sa lettre de base. Elles servent au calcul des retours à
 * la ligne : une légère marge est gardée au moment de couper.
 */

export type FontName = 'regular' | 'bold';

// Caractères ASCII 32..126.
const REGULAR_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

/** Code Windows-1252 des caractères hors Latin-1 (0x80..0x9F). */
const CP1252_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  ƒ: 0x83,
  '„': 0x84,
  '…': 0x85,
  '†': 0x86,
  '‡': 0x87,
  ˆ: 0x88,
  '‰': 0x89,
  Š: 0x8a,
  '‹': 0x8b,
  Œ: 0x8c,
  Ž: 0x8e,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '˜': 0x98,
  '™': 0x99,
  š: 0x9a,
  '›': 0x9b,
  œ: 0x9c,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** Largeurs spécifiques (Helvetica, Helvetica-Bold) des autres codes. */
const SPECIAL_WIDTHS: Record<number, [number, number]> = {
  0x80: [556, 556],
  0x82: [222, 278],
  0x83: [556, 556],
  0x84: [333, 500],
  0x85: [1000, 1000],
  0x86: [556, 556],
  0x87: [556, 556],
  0x88: [333, 333],
  0x89: [1000, 1000],
  0x8b: [333, 333],
  0x8c: [1000, 1000],
  0x91: [222, 278],
  0x92: [222, 278],
  0x93: [333, 500],
  0x94: [333, 500],
  0x95: [350, 350],
  0x96: [556, 556],
  0x97: [1000, 1000],
  0x98: [333, 333],
  0x99: [1000, 1000],
  0x9b: [333, 333],
  0x9c: [944, 944],
  0xa0: [278, 278],
  0xa1: [333, 333],
  0xa2: [556, 556],
  0xa3: [556, 556],
  0xa4: [556, 556],
  0xa5: [556, 556],
  0xa6: [260, 280],
  0xa7: [556, 556],
  0xa8: [333, 333],
  0xa9: [737, 737],
  0xaa: [370, 370],
  0xab: [556, 556],
  0xac: [584, 584],
  0xad: [333, 333],
  0xae: [737, 737],
  0xaf: [333, 333],
  0xb0: [400, 400],
  0xb1: [584, 584],
  0xb2: [333, 333],
  0xb3: [333, 333],
  0xb4: [333, 333],
  0xb5: [556, 611],
  0xb6: [537, 556],
  0xb7: [278, 278],
  0xb8: [333, 333],
  0xb9: [333, 333],
  0xba: [365, 365],
  0xbb: [556, 556],
  0xbc: [834, 834],
  0xbd: [834, 834],
  0xbe: [834, 834],
  0xbf: [611, 611],
  0xc6: [1000, 1000],
  // i accentués : 278 dans les deux graisses (AFM), contre 222 / 278 pour « i ».
  0xec: [278, 278],
  0xed: [278, 278],
  0xee: [278, 278],
  0xef: [278, 278],
  0xd0: [722, 722],
  0xd7: [584, 584],
  0xd8: [778, 778],
  0xde: [667, 667],
  0xdf: [611, 611],
  0xe6: [889, 889],
  0xf0: [556, 611],
  0xf7: [584, 584],
  0xf8: [611, 611],
  0xfe: [556, 611],
};

/** Code WinAnsi d'un caractère, ou `null` s'il n'y figure pas. */
function winAnsiCode(char: string): number | null {
  const code = char.codePointAt(0) ?? -1;
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  return CP1252_EXTRA[char] ?? null;
}

/**
 * 1-16D — caractères (distincts, dans l'ordre d'apparition) qu'Helvetica
 * WinAnsi ne peut pas reproduire À L'IDENTIQUE : écritures non latines,
 * émojis, lettres latines hors Windows-1252 (ā, ł, ő…), caractères de
 * contrôle, tabulations et retours à la ligne. Vide = texte reproductible.
 */
export function unsupportedPdfCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) {
    if (winAnsiCode(char) === null) found.add(char);
  }
  return [...found];
}

/** Texte que le PDF refuse de reproduire de façon approximative. */
export class PdfUnsupportedTextError extends Error {
  constructor(readonly characters: readonly string[]) {
    super(`Caractères non reproductibles : ${characters.join(' ')}`);
  }
}

/**
 * Encode un texte en octets WinAnsi, SANS AUCUNE SUBSTITUTION : un
 * caractère absent de l'encodage lève `PdfUnsupportedTextError` (jamais de
 * « ? », jamais de lettre sans accent). Les montants mis en forme par le
 * rapport utilisent l'espace insécable U+00A0, qui y figure.
 */
export function encodeWinAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = winAnsiCode(char);
    if (code === null) {
      throw new PdfUnsupportedTextError(unsupportedPdfCharacters(text));
    }
    bytes.push(code);
  }
  return bytes;
}

const LATIN1_BASE: Record<number, number> = {};
{
  // Lettre de base (ASCII) des lettres accentuées 0xC0..0xFF.
  const pairs: Array<[string, string]> = [
    ['ÀÁÂÃÄÅ', 'A'],
    ['Ç', 'C'],
    ['ÈÉÊË', 'E'],
    ['ÌÍÎÏ', 'I'],
    ['Ñ', 'N'],
    ['ÒÓÔÕÖ', 'O'],
    ['ÙÚÛÜ', 'U'],
    ['Ý', 'Y'],
    ['àáâãäå', 'a'],
    ['ç', 'c'],
    ['èéêë', 'e'],
    ['ñ', 'n'],
    ['òóôõö', 'o'],
    ['ùúûü', 'u'],
    ['ýÿ', 'y'],
    ['Šš', 'S'],
  ];
  for (const [chars, base] of pairs) {
    for (const ch of chars) {
      LATIN1_BASE[ch.charCodeAt(0)] = base.charCodeAt(0);
    }
  }
  LATIN1_BASE[0x8a] = 'S'.charCodeAt(0);
  LATIN1_BASE[0x9a] = 's'.charCodeAt(0);
  LATIN1_BASE[0x8e] = 'Z'.charCodeAt(0);
  LATIN1_BASE[0x9e] = 'z'.charCodeAt(0);
  LATIN1_BASE[0x9f] = 'Y'.charCodeAt(0);
}

export function byteWidth(byte: number, font: FontName): number {
  const table = font === 'bold' ? BOLD_ASCII : REGULAR_ASCII;
  if (byte >= 0x20 && byte <= 0x7e) return table[byte - 0x20];
  const special = SPECIAL_WIDTHS[byte];
  if (special) return special[font === 'bold' ? 1 : 0];
  const base = LATIN1_BASE[byte];
  if (base !== undefined) return table[base - 0x20];
  return 556;
}

/** Largeur en points d'un texte. */
export function textWidth(text: string, font: FontName, size: number): number {
  let total = 0;
  for (const byte of encodeWinAnsi(text)) total += byteWidth(byte, font);
  return (total * size) / 1000;
}
