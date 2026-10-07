import { inflateRawSync, inflateSync } from 'zlib';
import { BadRequestException } from '@nestjs/common';
import { columnName, xmlText } from './xlsx/xlsx-writer';
import { buildZip, crc32 } from './xlsx/zip';
import {
  encodeWinAnsi,
  PdfUnsupportedTextError,
  textWidth,
  unsupportedPdfCharacters,
} from './pdf/pdf-fonts';
import { CONTENT_WIDTH, PdfReport, wrapText } from './pdf/pdf-writer';
import { assertReportMonth } from './monthly-history.service';
import { renderMonthlyHistoryXlsx } from './monthly-history-xlsx';
import { renderMonthlyHistoryPdf } from './monthly-history-pdf';
import { REPORT_LABELS } from './report-labels';
import { excelSerial } from './report-format';
import { reportFilename } from './monthly-history.controller';
import type { MonthlyHistory } from './monthly-history.types';

function entries(zip: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (zip.readUInt32LE(p) === 0x04034b50) {
    const size = zip.readUInt32LE(p + 18);
    const nameLength = zip.readUInt16LE(p + 26);
    const name = zip.toString('utf8', p + 30, p + 30 + nameLength);
    const start = p + 30 + nameLength;
    out.set(
      name,
      inflateRawSync(zip.subarray(start, start + size)).toString('utf8'),
    );
    p = start + size;
  }
  return out;
}

// Windows-1252, table indépendante de l'implémentation. (Le
// `TextDecoder('windows-1252')` de Node décode 0x80..0x9F comme des
// caractères de contrôle Latin-1 : inutilisable pour ce contrôle.)
const CP1252_HIGH: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};
const cp1252 = {
  decode: (bytes: Uint8Array): string =>
    [...bytes].map((b) => CP1252_HIGH[b] ?? String.fromCharCode(b)).join(''),
};

function pdfStrings(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let text = '';
  for (const m of raw.matchAll(/>>\nstream\n/g)) {
    const start = m.index + m[0].length;
    const stop = raw.indexOf('\nendstream', start);
    const content = inflateSync(pdf.subarray(start, stop)).toString('latin1');
    for (const hex of content.matchAll(/<([0-9a-f]*)> Tj/g)) {
      text += `${cp1252.decode(Buffer.from(hex[1], 'hex'))}\n`;
    }
  }
  return text;
}

const L = REPORT_LABELS.fr;

function history(overrides: Partial<MonthlyHistory> = {}): MonthlyHistory {
  return {
    organization: { name: 'Boutique', slug: 'boutique' },
    period: {
      month: '2025-03',
      start: new Date(2025, 2, 1),
      end: new Date(2025, 3, 1),
      timeZone: 'UTC',
      isCurrentMonth: false,
    },
    generatedAt: new Date(2025, 3, 2, 9, 0),
    generatedBy: 'Propriétaire',
    rights: { financials: true, buyers: true },
    summary: {
      revenue: 800,
      quantity: 2,
      salesCount: 1,
      productsSold: 1,
      sellers: 1,
      estimatedGain: null,
      corrections: 0,
      cancellations: 0,
    },
    sales: [
      {
        date: new Date(2025, 2, 5, 14, 30),
        recordedName: '=SUM(A1:A9)',
        otherName: null,
        productState: 'deleted',
        quantity: 2,
        unitPrice: 400,
        amount: 800,
        sellerName: '+33 Vendeur',
        buyerName: '@acheteur',
        buyerContact: '-677',
      },
    ],
    products: [
      {
        name: null,
        productState: 'deleted',
        quantity: 2,
        salesCount: 1,
        revenue: 800,
        gain: null,
      },
    ],
    sellers: [{ name: null, quantity: 2, salesCount: 1, revenue: 800 }],
    movements: [],
    ...overrides,
  };
}

describe('1-16D — générateurs de rapports', () => {
  it('ZIP : CRC-32 standard', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const zip = buildZip(
      [{ name: 'a.txt', data: Buffer.from('é') }],
      new Date(2025, 0, 1),
    );
    expect(entries(zip).get('a.txt')).toBe('é');
  });

  it('XLSX : colonnes, échappement, caractères de contrôle retirés', () => {
    expect([0, 25, 26, 51, 52].map(columnName)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'BA',
    ]);
    expect(xmlText('a<b>&"c"\u0001\u0007d')).toBe(
      'a&lt;b&gt;&amp;&quot;c&quot;d',
    );
  });

  it('XLSX : un texte utilisateur reste du texte, jamais une formule ; nombres et dates typés', () => {
    const files = entries(renderMonthlyHistoryXlsx(history(), L));
    const all = [...files.values()].join('');
    expect(all).not.toMatch(/<f[ >]/);
    const sales = files.get('xl/worksheets/sheet2.xml')!;
    for (const text of ['=SUM(A1:A9)', '+33 Vendeur', '@acheteur', '-677']) {
      expect(sales).toContain(
        `t="inlineStr"><is><t xml:space="preserve">${text}</t>`,
      );
    }
    expect(sales).toContain(
      `<v>${excelSerial(new Date(2025, 2, 5, 14, 30))}</v>`,
    );
    expect(sales).toContain('<pane ySplit="1"');
    expect(sales).toContain('<autoFilter ref="A1:J2"/>');
    expect(files.get('xl/workbook.xml')).toContain('_xlnm.Print_Titles');
    expect(files.get('xl/styles.xml')).toContain('#,##0 &quot;FCFA&quot;');
  });

  it('XLSX et PDF : sans droit, ni colonnes acheteur ni gain', () => {
    const h = history({ rights: { financials: false, buyers: false } });
    h.sales[0] = {
      ...h.sales[0],
      buyerName: undefined,
      buyerContact: undefined,
    };
    h.products[0] = { ...h.products[0], gain: undefined };
    delete h.summary.estimatedGain;
    const all = [...entries(renderMonthlyHistoryXlsx(h, L)).values()].join('');
    expect(all).not.toContain(L.sales.buyer);
    expect(all).not.toContain(L.products.gain);
    const pdf = pdfStrings(renderMonthlyHistoryPdf(h, L));
    expect(pdf).not.toContain('Acheteur');
    expect(pdf).not.toContain('Gain');
  });

  it('valeur inconnue : « Information indisponible », jamais 0', () => {
    const files = entries(renderMonthlyHistoryXlsx(history(), L));
    const products = files.get('xl/worksheets/sheet3.xml')!;
    expect(products).toContain(L.common.unavailable);
    expect(products).not.toMatch(/<c r="F2"[^>]*><v>0<\/v>/);
    const pdf = pdfStrings(renderMonthlyHistoryPdf(history(), L));
    expect(pdf).toContain(L.common.unavailable);
    expect(pdf).toContain(L.common.productDeleted);
  });

  it('PDF : français exact (accents, œ/Œ, apostrophes typographiques), sans substitution', () => {
    const french =
      'Élève à l’œuvre — « Œufs frais » déjà prêts, ça coûte 5 € ; “ÇA” Ÿ…';
    expect(unsupportedPdfCharacters(french)).toEqual([]);
    expect(cp1252.decode(Uint8Array.from(encodeWinAnsi(french)))).toBe(french);
    const narrowSpace = String.fromCharCode(0x202f);
    const tab = String.fromCharCode(9);
    const newline = String.fromCharCode(10);
    for (const bad of [
      'ā',
      '😀',
      'Ж',
      'Łódź',
      narrowSpace,
      `a${tab}b`,
      `a${newline}b`,
    ]) {
      expect(unsupportedPdfCharacters(bad).length).toBeGreaterThan(0);
      expect(() => encodeWinAnsi(bad)).toThrow(PdfUnsupportedTextError);
    }
    expect(unsupportedPdfCharacters('Łódź Łódź 😀')).toEqual(['Ł', 'ź', '😀']);
    const lines = wrapText(`court ${'x'.repeat(200)}`, 'regular', 8, 60);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(textWidth(line, 'regular', 8)).toBeLessThanOrEqual(60);
    }
  });

  it('PDF : un nom non reproductible fait refuser le PDF ; l’Excel le garde exact', () => {
    const h = history();
    h.sales[0] = { ...h.sales[0], recordedName: 'Savon de Łódź 😀' };
    let caught: unknown;
    try {
      renderMonthlyHistoryPdf(h, L);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PdfUnsupportedTextError);
    expect((caught as PdfUnsupportedTextError).characters).toEqual([
      'Ł',
      'ź',
      '😀',
    ]);
    const sales = entries(renderMonthlyHistoryXlsx(h, L)).get(
      'xl/worksheets/sheet2.xml',
    )!;
    expect(sales).toContain('>Savon de Łódź 😀</t>');
  });

  it('PDF : textes français restitués à l’identique dans le fichier', () => {
    const h = history();
    h.organization.name = 'Boutique « Chez Zoé » & Œuvres';
    h.sales[0] = {
      ...h.sales[0],
      recordedName: 'Œufs l’été — crème brûlée',
      sellerName: 'Aïcha Ngô',
    };
    const text = pdfStrings(renderMonthlyHistoryPdf(h, L));
    for (const expected of [
      'Boutique « Chez Zoé » & Œuvres',
      'Œufs l’été — crème brûlée',
      'Aïcha Ngô',
      'Récapitulatif par produit',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('PDF : en-tête de tableau répété sur chaque page, pagination « n / N »', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      ...history().sales[0],
      recordedName: `Produit ${i}`,
    }));
    const text = pdfStrings(
      renderMonthlyHistoryPdf(history({ sales: many }), L),
    );
    const pages = Number(/Page 1 \/ (\d+)/.exec(text)?.[1]);
    expect(pages).toBeGreaterThan(3);
    expect(text).toContain(`Page ${pages} / ${pages}`);
    expect(
      text.split(`${L.sales.title} (suite)`).length - 1,
    ).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 120; i++) expect(text).toContain(`Produit ${i}\n`);
  });

  it('PDF : une largeur de tableau différente de la page est refusée', () => {
    const report = new PdfReport({
      title: 't',
      author: 'a',
      created: new Date(),
      headerLeft: '',
      headerRight: '',
      footerLeft: '',
      pageLabel: () => '',
    });
    expect(() =>
      report.table({
        title: 't',
        columns: [{ header: 'a', width: CONTENT_WIDTH - 10 }],
        rows: [],
        emptyText: '',
      }),
    ).toThrow();
  });

  it('mois demandé : format strict, jamais dans le futur', () => {
    const now = new Date(2026, 9, 7);
    expect(assertReportMonth('2026-10', now)).toBe('2026-10');
    expect(assertReportMonth('2025-01', now)).toBe('2025-01');
    for (const bad of ['2026-11', '2026-1', '2026-13', '1999-12', '2026-10x']) {
      expect(() => assertReportMonth(bad, now)).toThrow(BadRequestException);
    }
  });

  it('nom de fichier ASCII sûr', () => {
    expect(reportFilename('Boutique "x"/../', '2025-03', 'pdf')).toBe(
      'historique-boutique-x-2025-03.pdf',
    );
    expect(reportFilename('', '2025-03', 'xlsx')).toBe(
      'historique-commerce-2025-03.xlsx',
    );
  });
});
