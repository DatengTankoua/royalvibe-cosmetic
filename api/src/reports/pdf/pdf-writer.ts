import { deflateSync } from 'zlib';
import { encodeWinAnsi, FontName, textWidth } from './pdf-fonts';

/**
 * 1-16D — document PDF 1.4 minimal, sans dépendance : pages A4 paysage,
 * Helvetica standard (WinAnsi), flux compressés. Mise en page en
 * coordonnées « depuis le haut » ; conversion au repère PDF à l'écriture.
 *
 * Tableaux : colonnes de largeur fixe (aucune colonne coupée : la somme
 * des largeurs est vérifiée), textes longs répartis sur plusieurs lignes,
 * saut de page avant une ligne qui ne tient plus, en-tête répété en haut de
 * chaque page, titre « (suite) ».
 */

export type Rgb = readonly [number, number, number];

export const COLORS = {
  ink: [0.07, 0.09, 0.15] as Rgb,
  muted: [0.36, 0.4, 0.47] as Rgb,
  headerFill: [0.12, 0.16, 0.22] as Rgb,
  headerText: [1, 1, 1] as Rgb,
  zebra: [0.96, 0.96, 0.97] as Rgb,
  totalFill: [0.9, 0.91, 0.93] as Rgb,
  rule: [0.8, 0.82, 0.86] as Rgb,
  cardFill: [0.97, 0.97, 0.98] as Rgb,
};

const PAGE_WIDTH = 842; // A4 paysage, points
const PAGE_HEIGHT = 595;
const MARGIN_X = 36;
const CONTENT_TOP = 70; // sous l'en-tête de page
const CONTENT_BOTTOM = PAGE_HEIGHT - 44; // au-dessus du pied de page
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;
/** Marge de sécurité sur les largeurs mesurées avant de couper une ligne. */
const WRAP_SAFETY = 0.97;

function hexOf(text: string): string {
  return encodeWinAnsi(text)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const num = (n: number) => (Math.round(n * 100) / 100).toString();
const rgb = ([r, g, b]: Rgb) => `${num(r)} ${num(g)} ${num(b)}`;

/** Coupe un texte en lignes d'au plus `maxWidth` points. */
export function wrapText(
  text: string,
  font: FontName,
  size: number,
  maxWidth: number,
): string[] {
  const limit = maxWidth * WRAP_SAFETY;
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    // Espaces seulement : une tabulation est refusée en amont, jamais remplacée.
    const words = paragraph.split(/ +/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, font, size) <= limit) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      // Mot plus large que la colonne : coupé caractère par caractère.
      let piece = '';
      for (const char of word) {
        if (piece && textWidth(piece + char, font, size) > limit) {
          lines.push(piece);
          piece = char;
        } else {
          piece += char;
        }
      }
      current = piece;
    }
    lines.push(current);
  }
  return lines;
}

class Page {
  readonly ops: string[] = [];

  text(
    x: number,
    top: number,
    value: string,
    font: FontName,
    size: number,
    color: Rgb = COLORS.ink,
  ) {
    if (!value) return;
    const baseline = PAGE_HEIGHT - top - size * 0.8;
    this.ops.push(
      `BT /${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf ${rgb(color)} rg 1 0 0 1 ${num(x)} ${num(baseline)} Tm <${hexOf(value)}> Tj ET`,
    );
  }

  rect(x: number, top: number, width: number, height: number, fill: Rgb) {
    this.ops.push(
      `${rgb(fill)} rg ${num(x)} ${num(PAGE_HEIGHT - top - height)} ${num(width)} ${num(height)} re f`,
    );
  }

  hline(x: number, top: number, width: number, color: Rgb, weight = 0.5) {
    const y = num(PAGE_HEIGHT - top);
    this.ops.push(
      `${rgb(color)} RG ${num(weight)} w ${num(x)} ${y} m ${num(x + width)} ${y} l S`,
    );
  }
}

export interface TableColumn {
  header: string;
  /** Largeur en points ; la somme doit valoir `CONTENT_WIDTH`. */
  width: number;
  align?: 'left' | 'right';
}

export interface TableSpec {
  title: string;
  columns: readonly TableColumn[];
  rows: ReadonlyArray<readonly string[]>;
  emptyText: string;
  total?: readonly string[];
}

const BODY_SIZE = 8;
const LINE = 10; // interligne des cellules
const PAD = 4;

export class PdfReport {
  private readonly pages: Page[] = [];
  private page!: Page;
  private y = CONTENT_TOP;

  constructor(
    private readonly meta: {
      title: string;
      author: string;
      created: Date;
      headerLeft: string;
      headerRight: string;
      footerLeft: string;
      pageLabel: (page: number, total: number) => string;
    },
  ) {
    this.newPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  newPage() {
    this.page = new Page();
    this.pages.push(this.page);
    this.y = CONTENT_TOP;
  }

  private ensure(height: number) {
    if (this.y + height > CONTENT_BOTTOM) this.newPage();
  }

  space(height: number) {
    this.y += height;
  }

  title(text: string, subtitle?: string) {
    this.page.text(MARGIN_X, this.y, text, 'bold', 18);
    this.y += 26;
    if (subtitle) this.paragraph(subtitle, { size: 11, color: COLORS.muted });
  }

  heading(text: string, keepWith = 60) {
    this.ensure(18 + keepWith);
    this.page.text(MARGIN_X, this.y, text, 'bold', 12);
    this.y += 16;
    this.page.hline(MARGIN_X, this.y, CONTENT_WIDTH, COLORS.rule);
    this.y += 6;
  }

  paragraph(
    text: string,
    options: { size?: number; color?: Rgb; font?: FontName } = {},
  ) {
    const size = options.size ?? 9;
    const lineHeight = size * 1.3;
    for (const line of wrapText(
      text,
      options.font ?? 'regular',
      size,
      CONTENT_WIDTH,
    )) {
      this.ensure(lineHeight);
      this.page.text(
        MARGIN_X,
        this.y,
        line,
        options.font ?? 'regular',
        size,
        options.color,
      );
      this.y += lineHeight;
    }
    this.y += 4;
  }

  /** Chiffres essentiels : cartes de même largeur sur une ligne. */
  cards(items: ReadonlyArray<{ label: string; value: string; note?: string }>) {
    const gap = 10;
    const width = (CONTENT_WIDTH - gap * (items.length - 1)) / items.length;
    const inner = width - 2 * 8;
    const valueLines = items.map((i) => wrapText(i.value, 'bold', 14, inner));
    const noteLines = items.map((i) =>
      i.note ? wrapText(i.note, 'regular', 7.5, inner) : [],
    );
    const height =
      8 +
      12 +
      Math.max(...valueLines.map((l) => l.length)) * 17 +
      Math.max(...noteLines.map((l) => l.length)) * 9.5 +
      8;
    this.ensure(height);
    items.forEach((item, i) => {
      const x = MARGIN_X + i * (width + gap);
      this.page.rect(x, this.y, width, height, COLORS.cardFill);
      this.page.text(x + 8, this.y + 8, item.label, 'regular', 8, COLORS.muted);
      let top = this.y + 20;
      for (const line of valueLines[i]) {
        this.page.text(x + 8, top, line, 'bold', 14);
        top += 17;
      }
      for (const line of noteLines[i]) {
        this.page.text(x + 8, top, line, 'regular', 7.5, COLORS.muted);
        top += 9.5;
      }
    });
    this.y += height + 12;
  }

  /** Paires libellé / valeur sur deux colonnes. */
  keyValues(pairs: ReadonlyArray<readonly [string, string]>) {
    const labelWidth = 190;
    const valueWidth = CONTENT_WIDTH - labelWidth;
    for (const [label, value] of pairs) {
      const labelLines = wrapText(label, 'bold', 9, labelWidth - 8);
      const valueLines = wrapText(value, 'regular', 9, valueWidth);
      const height = Math.max(labelLines.length, valueLines.length) * 12 + 2;
      this.ensure(height);
      labelLines.forEach((l, i) =>
        this.page.text(MARGIN_X, this.y + i * 12, l, 'bold', 9),
      );
      valueLines.forEach((l, i) =>
        this.page.text(MARGIN_X + labelWidth, this.y + i * 12, l, 'regular', 9),
      );
      this.y += height;
    }
    this.y += 6;
  }

  table(spec: TableSpec) {
    const total = spec.columns.reduce((n, c) => n + c.width, 0);
    if (Math.abs(total - CONTENT_WIDTH) > 0.5) {
      throw new Error(`Largeur de tableau ${total} ≠ ${CONTENT_WIDTH}`);
    }
    const cellLines = (row: readonly string[], font: FontName) =>
      spec.columns.map((col, i) =>
        wrapText(row[i] ?? '', font, BODY_SIZE, col.width - 2 * PAD),
      );
    const headerLines = cellLines(
      spec.columns.map((c) => c.header),
      'bold',
    );
    const headerHeight =
      Math.max(...headerLines.map((l) => l.length)) * LINE + 2 * PAD;
    // Une ligne ne dépasse jamais une page : au-delà, coupée (texte
    // anormalement long), signalée par « … ».
    const maxRowLines = Math.floor(
      (CONTENT_BOTTOM - CONTENT_TOP - 22 - headerHeight - 2 * PAD) / LINE,
    );

    const drawHeader = () => {
      this.page.rect(
        MARGIN_X,
        this.y,
        CONTENT_WIDTH,
        headerHeight,
        COLORS.headerFill,
      );
      this.drawCells(headerLines, 'bold', COLORS.headerText, spec.columns);
      this.y += headerHeight;
    };

    const firstRow = spec.rows[0]
      ? cellLines(spec.rows[0], 'regular')
      : [[spec.emptyText]];
    const firstHeight =
      Math.max(...firstRow.map((l) => l.length)) * LINE + 2 * PAD;
    this.heading(spec.title, headerHeight + firstHeight);
    drawHeader();

    if (spec.rows.length === 0) {
      this.page.text(
        MARGIN_X + PAD,
        this.y + PAD,
        spec.emptyText,
        'regular',
        BODY_SIZE,
        COLORS.muted,
      );
      this.y += LINE + 2 * PAD + 10;
      return;
    }

    const allRows = [
      ...spec.rows.map((r) => ({ cells: r, total: false })),
      ...(spec.total ? [{ cells: spec.total, total: true }] : []),
    ];
    allRows.forEach((row, index) => {
      const font: FontName = row.total ? 'bold' : 'regular';
      let lines = cellLines(row.cells, font);
      if (lines.some((l) => l.length > maxRowLines)) {
        lines = lines.map((l) =>
          l.length > maxRowLines
            ? [...l.slice(0, maxRowLines - 1), `${l[maxRowLines - 1]}…`]
            : l,
        );
      }
      const height = Math.max(...lines.map((l) => l.length)) * LINE + 2 * PAD;
      if (this.y + height > CONTENT_BOTTOM) {
        this.newPage();
        this.page.text(
          MARGIN_X,
          this.y,
          `${spec.title} (suite)`,
          'bold',
          10,
          COLORS.muted,
        );
        this.y += 16;
        drawHeader();
      }
      if (row.total) {
        this.page.rect(
          MARGIN_X,
          this.y,
          CONTENT_WIDTH,
          height,
          COLORS.totalFill,
        );
      } else if (index % 2 === 1) {
        this.page.rect(MARGIN_X, this.y, CONTENT_WIDTH, height, COLORS.zebra);
      }
      this.drawCells(lines, font, COLORS.ink, spec.columns);
      this.y += height;
      this.page.hline(MARGIN_X, this.y, CONTENT_WIDTH, COLORS.rule, 0.3);
    });
    this.y += 14;
  }

  private drawCells(
    lines: string[][],
    font: FontName,
    color: Rgb,
    columns: readonly TableColumn[],
  ) {
    let x = MARGIN_X;
    columns.forEach((col, i) => {
      lines[i].forEach((line, j) => {
        const left =
          col.align === 'right'
            ? x + col.width - PAD - textWidth(line, font, BODY_SIZE)
            : x + PAD;
        this.page.text(
          left,
          this.y + PAD + j * LINE,
          line,
          font,
          BODY_SIZE,
          color,
        );
      });
      x += col.width;
    });
  }

  /** Assemble le fichier : en-têtes et pieds de page, « Page n / N ». */
  toBuffer(): Buffer {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      page.text(MARGIN_X, 26, this.meta.headerLeft, 'bold', 10);
      const right = this.meta.headerRight;
      page.text(
        PAGE_WIDTH - MARGIN_X - textWidth(right, 'regular', 9),
        27,
        right,
        'regular',
        9,
        COLORS.muted,
      );
      page.hline(MARGIN_X, 44, CONTENT_WIDTH, COLORS.rule);
      const footerTop = PAGE_HEIGHT - 30;
      page.hline(MARGIN_X, footerTop - 6, CONTENT_WIDTH, COLORS.rule, 0.3);
      page.text(
        MARGIN_X,
        footerTop,
        this.meta.footerLeft,
        'regular',
        7.5,
        COLORS.muted,
      );
      const label = this.meta.pageLabel(i + 1, total);
      page.text(
        PAGE_WIDTH - MARGIN_X - textWidth(label, 'regular', 7.5),
        footerTop,
        label,
        'regular',
        7.5,
        COLORS.muted,
      );
    });
    return serializePdf(
      this.pages.map((p) => p.ops.join('\n')),
      this.meta,
    );
  }
}

/** Chaîne de métadonnées PDF en UTF-16BE (accents exacts). */
function pdfTextString(value: string): string {
  const utf16 = Buffer.from(`\ufeff${value}`, 'utf16le').swap16();
  return `<${utf16.toString('hex')}>`;
}

function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

function serializePdf(
  contents: readonly string[],
  meta: { title: string; author: string; created: Date },
): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => {
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
    return objects.length;
  };
  const catalogId = add(''); // rempli plus bas
  const pagesId = add('');
  const regularId = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  const boldId = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  const infoId = add(
    `<< /Title ${pdfTextString(meta.title)} /Author ${pdfTextString(meta.author)} /Producer (Stock Master) /CreationDate (${pdfDate(meta.created)}) >>`,
  );
  const pageIds: number[] = [];
  for (const content of contents) {
    const stream = deflateSync(Buffer.from(content, 'latin1'));
    const contentId = add(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
          'latin1',
        ),
        stream,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${regularId} 0 R /F2 ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalogId - 1] = Buffer.from(
    `<< /Type /Catalog /Pages ${pagesId} 0 R >>`,
    'latin1',
  );
  objects[pagesId - 1] = Buffer.from(
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`,
    'latin1',
  );

  const chunks: Buffer[] = [
    Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1'),
  ];
  let offset = chunks[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
