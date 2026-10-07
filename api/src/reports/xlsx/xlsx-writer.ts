import { buildZip } from './zip';

/**
 * 1-16D — classeur `.xlsx` (SpreadsheetML / OOXML) minimal, sans
 * dépendance. Garanties :
 * - un texte est TOUJOURS une chaîne en ligne (`t="inlineStr"`) : aucune
 *   cellule de formule n'est jamais écrite, un texte commençant par `=`,
 *   `+`, `-` ou `@` reste du texte ;
 * - nombres et dates typés (dates = numéros de série Excel, format date) ;
 * - en-têtes figés, filtres automatiques, largeurs de colonnes, mise en page
 *   paysage avec lignes d'en-tête répétées à l'impression.
 */

export type CellStyle =
  | 'header'
  | 'text'
  | 'wrap'
  | 'integer'
  | 'money'
  | 'datetime'
  | 'date'
  | 'title'
  | 'label'
  | 'totalText'
  | 'totalInteger'
  | 'totalMoney'
  | 'muted'
  | 'subtitle';

export type Cell =
  | null
  | { kind: 'text'; value: string; style?: CellStyle }
  | { kind: 'number'; value: number; style?: CellStyle }
  | { kind: 'date'; serial: number; style?: CellStyle };

export interface SheetSpec {
  name: string;
  /** Largeurs en caractères. */
  columns: readonly number[];
  rows: ReadonlyArray<readonly Cell[]>;
  /** Ligne d'en-tête du tableau (0-based) : figée, filtrée, répétée. */
  table?: { headerRow: number; lastRow: number };
}

const STYLE_INDEX: Record<CellStyle, number> = {
  header: 1,
  text: 2,
  wrap: 3,
  integer: 4,
  money: 5,
  datetime: 6,
  date: 7,
  title: 8,
  label: 9,
  totalText: 10,
  totalInteger: 11,
  totalMoney: 12,
  muted: 13,
  subtitle: 14,
};

/** Plus longue chaîne acceptée par Excel dans une cellule. */
const EXCEL_MAX_TEXT = 32_767;

// Caractères interdits en XML 1.0 (contrôles hors tabulation et retours).
const INVALID_XML = /[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu;

export function xmlText(value: string): string {
  return value
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function cellXml(cell: Cell, ref: string): string {
  if (cell === null) return '';
  const s = cell.style ? ` s="${STYLE_INDEX[cell.style]}"` : '';
  switch (cell.kind) {
    case 'text': {
      const text = xmlText(cell.value.slice(0, EXCEL_MAX_TEXT));
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
    }
    case 'number':
      if (!Number.isFinite(cell.value)) return '';
      return `<c r="${ref}"${s}><v>${cell.value}</v></c>`;
    case 'date':
      return `<c r="${ref}"${s}><v>${cell.serial}</v></c>`;
  }
}

function quoteSheet(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

function sheetXml(sheet: SheetSpec, selected: boolean): string {
  const width = Math.max(1, sheet.columns.length);
  const height = Math.max(1, sheet.rows.length);
  const lastCol = columnName(width - 1);
  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => cellXml(cell, `${columnName(c)}${r + 1}`))
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const cols = sheet.columns
    .map(
      (w, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`,
    )
    .join('');
  let pane = '';
  let filter = '';
  if (sheet.table) {
    const top = sheet.table.headerRow + 2;
    pane =
      `<pane ySplit="${sheet.table.headerRow + 1}" topLeftCell="A${top}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${top}" sqref="A${top}"/>`;
    filter = `<autoFilter ref="A${sheet.table.headerRow + 1}:${lastCol}${sheet.table.lastRow + 1}"/>`;
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:${lastCol}${height}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `<cols>${cols}</cols>` +
    `<sheetData>${rows}</sheetData>` +
    filter +
    '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>' +
    '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
    '<headerFooter><oddFooter>&amp;L&amp;A&amp;RPage &amp;P / &amp;N</oddFooter></headerFooter>' +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="3">' +
  '<numFmt numFmtId="164" formatCode="#,##0 &quot;FCFA&quot;"/>' +
  '<numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/>' +
  '<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/>' +
  '</numFmts>' +
  '<fonts count="6">' +
  '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><i/><sz val="10"/><color rgb="FF4B5563"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><sz val="11"/><color rgb="FF4B5563"/><name val="Calibri"/><family val="2"/></font>' +
  '</fonts>' +
  '<fills count="4">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="2">' +
  '<border><left/><right/><top/><bottom/><diagonal/></border>' +
  '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>' +
  '</borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="15">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  // 1 header
  '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  // 2 text
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>' +
  // 3 wrap
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  // 4 integer
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  // 5 money
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  // 6 datetime
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>' +
  // 7 date
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>' +
  // 8 title
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  // 9 label
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  // 10 totalText
  '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  // 11 totalInteger
  '<xf numFmtId="3" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  // 12 totalMoney
  '<xf numFmtId="164" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>' +
  // 13 muted
  '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  // 14 subtitle
  '<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

export function buildWorkbook(
  sheets: readonly SheetSpec[],
  meta: { title: string; creator: string; created: Date },
): Buffer {
  const definedNames = sheets
    .flatMap((sheet, i) => {
      if (!sheet.table) return [];
      const lastCol = columnName(Math.max(1, sheet.columns.length) - 1);
      const head = sheet.table.headerRow + 1;
      const q = xmlText(quoteSheet(sheet.name));
      return [
        `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${q}!$A$${head}:$${lastCol}$${sheet.table.lastRow + 1}</definedName>`,
        `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">${q}!$${head}:$${head}</definedName>`,
      ];
    })
    .join('');
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    '<sheets>' +
    sheets
      .map(
        (s, i) =>
          `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('') +
    '</sheets>' +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : '') +
    '</workbook>';
  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  const iso = meta.created.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const core =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(meta.title)}</dc:title>` +
    `<dc:creator>${xmlText(meta.creator)}</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>` +
    '</cp:coreProperties>';
  const app =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Stock Master</Application></Properties>';

  const utf8 = (s: string) => Buffer.from(s, 'utf8');
  return buildZip(
    [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rootRels) },
      { name: 'docProps/core.xml', data: utf8(core) },
      { name: 'docProps/app.xml', data: utf8(app) },
      { name: 'xl/workbook.xml', data: utf8(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
      { name: 'xl/styles.xml', data: utf8(STYLES_XML) },
      ...sheets.map((sheet, i) => ({
        name: `xl/worksheets/sheet${i + 1}.xml`,
        data: utf8(sheetXml(sheet, i === 0)),
      })),
    ],
    meta.created,
  );
}
