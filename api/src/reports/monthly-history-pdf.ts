import { PdfReport, TableColumn } from './pdf/pdf-writer';
import {
  formatDateTime,
  formatInteger,
  formatMoney,
  formatMonthLabel,
} from './report-format';
import type { ReportLabels } from './report-labels';
import type { MonthlyHistory } from './monthly-history.types';
import { productStateLabel } from './monthly-history-xlsx';
import {
  PdfUnsupportedTextError,
  unsupportedPdfCharacters,
} from './pdf/pdf-fonts';

/**
 * 1-16D — textes ENREGISTRÉS reproduits dans le PDF (commerce, auteur,
 * produits, vendeurs, acheteurs). Un seul caractère non reproductible à
 * l'identique fait refuser tout le PDF, avant la mise en page : aucun nom
 * n'est jamais remplacé ni approché. L'Excel les conserve exactement.
 */
export function assertPdfReproducible(history: MonthlyHistory): void {
  const texts: Array<string | null | undefined> = [
    history.organization.name,
    history.generatedBy,
    ...history.sales.flatMap((s) => [
      s.recordedName,
      s.otherName,
      s.sellerName,
      s.buyerName,
      s.buyerContact,
    ]),
    ...history.products.map((p) => p.name),
    ...history.sellers.map((v) => v.name),
    ...history.movements.flatMap((m) => [m.productName, m.actorName]),
  ];
  const found = new Set<string>();
  for (const text of texts) {
    if (text) for (const c of unsupportedPdfCharacters(text)) found.add(c);
  }
  if (found.size > 0) throw new PdfUnsupportedTextError([...found]);
}

export function renderMonthlyHistoryPdf(
  history: MonthlyHistory,
  labels: ReportLabels,
): Buffer {
  assertPdfReproducible(history);
  const L = labels.summary;
  const s = history.summary;
  const monthLabel = formatMonthLabel(labels, history.period.month);
  const n = (v: number) => formatInteger(labels, v);
  const m = (v: number) => formatMoney(labels, v);
  const unavailable = labels.common.unavailable;

  const report = new PdfReport({
    title: `${labels.documentTitle} — ${history.organization.name} — ${monthLabel}`,
    author: 'Stock Master',
    created: history.generatedAt,
    headerLeft: history.organization.name,
    headerRight: `${labels.documentTitle} · ${monthLabel}`,
    footerLeft: `${L.generatedAt} ${formatDateTime(history.generatedAt)} · ${L.timeZone} : ${history.period.timeZone}`,
    pageLabel: labels.common.page,
  });

  // ── Bilan ────────────────────────────────────────────────────────────────
  report.title(
    labels.documentTitle,
    `${history.organization.name} · ${monthLabel}`,
  );
  const end = new Date(history.period.end.getTime() - 60_000);
  report.keyValues([
    [L.business, history.organization.name],
    [
      L.period,
      `${monthLabel} : du ${formatDateTime(history.period.start)} au ${formatDateTime(end)}`,
    ],
    [L.timeZone, history.period.timeZone],
    [L.generatedAt, formatDateTime(history.generatedAt)],
    [L.generatedBy, history.generatedBy ?? unavailable],
    ...(history.period.isCurrentMonth
      ? [['', L.currentMonth] as [string, string]]
      : []),
  ]);
  const gainUnknown =
    history.rights.financials &&
    (s.estimatedGain === null || s.estimatedGain === undefined);
  report.cards([
    { label: L.revenue, value: m(s.revenue) },
    { label: L.quantity, value: n(s.quantity) },
    { label: L.salesCount, value: n(s.salesCount) },
    ...(history.rights.financials
      ? [
          {
            label: L.estimatedGain,
            value: gainUnknown ? unavailable : m(s.estimatedGain ?? 0),
            note: gainUnknown ? L.notes.gainUnknown : undefined,
          },
        ]
      : []),
  ]);
  report.keyValues([
    [L.productsSold, n(s.productsSold)],
    [L.sellers, n(s.sellers)],
    [L.corrections, n(s.corrections)],
    [L.cancellations, n(s.cancellations)],
  ]);
  if (s.salesCount === 0) report.paragraph(L.noSales, { font: 'bold' });
  report.heading(L.notesTitle, 30);
  for (const note of [
    L.notes.pending,
    L.notes.bounds(history.period.timeZone),
    L.notes.current,
    L.notes.names,
    ...(history.rights.financials ? [L.notes.gain] : []),
    L.notes.movements,
  ]) {
    report.paragraph(`• ${note}`, { size: 8.5 });
  }

  // ── Tableaux complets ────────────────────────────────────────────────────
  report.newPage();
  const S = labels.sales;
  const buyers = history.rights.buyers;
  const salesColumns: TableColumn[] = [
    { header: S.date, width: 62 },
    { header: S.product, width: buyers ? 140 : 190 },
    { header: S.currentName, width: buyers ? 112 : 172 },
    { header: S.productState, width: 66 },
    { header: S.quantity, width: 46, align: 'right' },
    { header: S.unitPrice, width: 70, align: 'right' },
    { header: S.amount, width: 76, align: 'right' },
    { header: S.seller, width: 88 },
    ...(buyers ? [{ header: S.buyer, width: 110 }] : []),
  ];
  report.table({
    title: S.title,
    columns: salesColumns,
    emptyText: S.empty,
    rows: history.sales.map((sale) => [
      formatDateTime(sale.date),
      sale.recordedName ?? S.nameNotRecorded,
      sale.otherName ?? '',
      productStateLabel(labels, sale.productState),
      n(sale.quantity),
      m(sale.unitPrice),
      m(sale.amount),
      sale.sellerName ?? labels.common.sellerUnavailable,
      ...(buyers
        ? [[sale.buyerName, sale.buyerContact].filter(Boolean).join('\n')]
        : []),
    ]),
    total: [
      S.total,
      '',
      '',
      '',
      n(s.quantity),
      '',
      m(s.revenue),
      '',
      ...(buyers ? [''] : []),
    ],
  });

  const P = labels.products;
  const financials = history.rights.financials;
  report.table({
    title: P.title,
    columns: [
      { header: P.product, width: financials ? 300 : 400 },
      { header: P.state, width: 110 },
      { header: P.quantity, width: 80, align: 'right' },
      { header: P.salesCount, width: 80, align: 'right' },
      { header: P.revenue, width: 100, align: 'right' },
      ...(financials
        ? [{ header: P.gain, width: 100, align: 'right' as const }]
        : []),
    ],
    emptyText: P.empty,
    rows: history.products.map((p) => [
      p.name ?? unavailable,
      productStateLabel(labels, p.productState),
      n(p.quantity),
      n(p.salesCount),
      m(p.revenue),
      ...(financials
        ? [p.gain === null || p.gain === undefined ? unavailable : m(p.gain)]
        : []),
    ]),
    total: [
      S.total,
      '',
      n(s.quantity),
      n(s.salesCount),
      m(s.revenue),
      ...(financials
        ? [gainUnknown ? unavailable : m(s.estimatedGain ?? 0)]
        : []),
    ],
  });

  const V = labels.sellers;
  report.table({
    title: V.title,
    columns: [
      { header: V.seller, width: 380 },
      { header: V.quantity, width: 120, align: 'right' },
      { header: V.salesCount, width: 120, align: 'right' },
      { header: V.revenue, width: 150, align: 'right' },
    ],
    emptyText: V.empty,
    rows: history.sellers.map((v) => [
      v.name ?? labels.common.sellerUnavailable,
      n(v.quantity),
      n(v.salesCount),
      m(v.revenue),
    ]),
    total: [S.total, n(s.quantity), n(s.salesCount), m(s.revenue)],
  });

  const M = labels.movements;
  const before = (
    value: number | null,
    fmt: (v: number) => string,
    kind: string,
  ) =>
    value === null
      ? kind === 'correction'
        ? M.unchanged
        : unavailable
      : fmt(value);
  const after = (
    value: number | null,
    fmt: (v: number) => string,
    kind: string,
  ) =>
    kind === 'cancellation'
      ? labels.common.none
      : value === null
        ? M.unchanged
        : fmt(value);
  report.table({
    title: M.title,
    columns: [
      { header: M.date, width: 62 },
      { header: M.kind, width: 62 },
      { header: M.product, width: 240 },
      { header: M.saleDate, width: 66 },
      { header: M.quantityBefore, width: 50, align: 'right' },
      { header: M.quantityAfter, width: 50, align: 'right' },
      { header: M.priceBefore, width: 70, align: 'right' },
      { header: M.priceAfter, width: 70, align: 'right' },
      { header: M.actor, width: 100 },
    ],
    emptyText: M.empty,
    rows: history.movements.map((mv) => [
      formatDateTime(mv.date),
      mv.kind === 'correction' ? M.correction : M.cancellation,
      [
        mv.productName ?? unavailable,
        mv.productDeleted ? labels.common.productDeleted : '',
      ]
        .filter(Boolean)
        .join('\n'),
      mv.saleDate ? formatDateTime(mv.saleDate) : unavailable,
      before(mv.quantityBefore, n, mv.kind),
      after(mv.quantityAfter, n, mv.kind),
      before(mv.priceBefore, m, mv.kind),
      after(mv.priceAfter, m, mv.kind),
      mv.actorName ?? unavailable,
    ]),
  });

  return report.toBuffer();
}
