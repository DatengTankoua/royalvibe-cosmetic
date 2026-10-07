import { buildWorkbook, Cell, CellStyle, SheetSpec } from './xlsx/xlsx-writer';
import { excelSerial, formatMoney, formatMonthLabel } from './report-format';
import type { ReportLabels } from './report-labels';
import type { MonthlyHistory, ProductState } from './monthly-history.types';

const text = (value: string, style: CellStyle = 'text'): Cell => ({
  kind: 'text',
  value,
  style,
});
const int = (value: number, style: CellStyle = 'integer'): Cell => ({
  kind: 'number',
  value,
  style,
});
const money = (value: number, style: CellStyle = 'money'): Cell => ({
  kind: 'number',
  value,
  style,
});
const dateTime = (value: Date, style: CellStyle = 'datetime'): Cell => ({
  kind: 'date',
  serial: excelSerial(value),
  style,
});

export function productStateLabel(
  labels: ReportLabels,
  state: ProductState,
): string {
  if (state === 'deleted') return labels.common.productDeleted;
  if (state === 'trash') return labels.common.productInTrash;
  return labels.common.productAvailable;
}

/** Détail lisible d'une correction ou d'une annulation. */
export function movementDetail(
  labels: ReportLabels,
  m: MonthlyHistory['movements'][number],
): string {
  const L = labels.movements;
  if (m.kind === 'cancellation') {
    return L.detailCancelled(
      m.quantityBefore === null
        ? labels.common.unavailable
        : String(m.quantityBefore),
      m.priceBefore === null
        ? labels.common.unavailable
        : formatMoney(labels, m.priceBefore),
    );
  }
  const parts: string[] = [];
  if (m.quantityBefore !== null && m.quantityAfter !== null) {
    parts.push(
      L.detailQuantity(String(m.quantityBefore), String(m.quantityAfter)),
    );
  }
  if (m.priceBefore !== null && m.priceAfter !== null) {
    parts.push(
      L.detailPrice(
        formatMoney(labels, m.priceBefore),
        formatMoney(labels, m.priceAfter),
      ),
    );
  }
  return parts.join(' ; ');
}

function summarySheet(
  history: MonthlyHistory,
  labels: ReportLabels,
): SheetSpec {
  const L = labels.summary;
  const s = history.summary;
  const rows: Cell[][] = [
    [text(labels.documentTitle, 'title')],
    [
      text(
        `${history.organization.name} — ${formatMonthLabel(labels, history.period.month)}`,
        'subtitle',
      ),
    ],
    [],
    [text(L.business, 'label'), text(history.organization.name)],
    [
      text(L.period, 'label'),
      text(formatMonthLabel(labels, history.period.month)),
    ],
    [text(L.periodStart, 'label'), dateTime(history.period.start)],
    [
      text(L.periodEnd, 'label'),
      dateTime(new Date(history.period.end.getTime() - 1000)),
    ],
    [text(L.timeZone, 'label'), text(history.period.timeZone)],
    [text(L.generatedAt, 'label'), dateTime(history.generatedAt)],
    [
      text(L.generatedBy, 'label'),
      text(history.generatedBy ?? labels.common.unavailable),
    ],
  ];
  if (history.period.isCurrentMonth)
    rows.push([null, text(L.currentMonth, 'muted')]);
  rows.push(
    [],
    [text(L.title, 'label')],
    [text(L.revenue, 'label'), money(s.revenue)],
    [text(L.quantity, 'label'), int(s.quantity)],
    [text(L.salesCount, 'label'), int(s.salesCount)],
    [text(L.productsSold, 'label'), int(s.productsSold)],
    [text(L.sellers, 'label'), int(s.sellers)],
  );
  if (history.rights.financials) {
    rows.push([
      text(L.estimatedGain, 'label'),
      s.estimatedGain === null || s.estimatedGain === undefined
        ? text(labels.common.unavailable)
        : money(s.estimatedGain),
    ]);
  }
  rows.push(
    [text(L.corrections, 'label'), int(s.corrections)],
    [text(L.cancellations, 'label'), int(s.cancellations)],
  );
  if (s.salesCount === 0) rows.push([null, text(L.noSales, 'muted')]);
  rows.push([], [text(L.notesTitle, 'label')]);
  const notes = [
    L.notes.pending,
    L.notes.bounds(history.period.timeZone),
    L.notes.current,
    L.notes.names,
    ...(history.rights.financials ? [L.notes.gain] : []),
    ...(history.rights.financials && s.estimatedGain === null
      ? [L.notes.gainUnknown]
      : []),
    L.notes.movements,
  ];
  for (const note of notes)
    rows.push([text('•', 'muted'), text(note, 'muted')]);
  return { name: L.sheet, columns: [34, 100], rows };
}

function salesSheet(history: MonthlyHistory, labels: ReportLabels): SheetSpec {
  const L = labels.sales;
  const buyers = history.rights.buyers;
  const header = [
    L.date,
    L.product,
    L.currentName,
    L.productState,
    L.quantity,
    L.unitPrice,
    L.amount,
    L.seller,
    ...(buyers ? [L.buyer, L.buyerContact] : []),
  ].map((h) => text(h, 'header'));
  const rows: Cell[][] = [header];
  for (const sale of history.sales) {
    rows.push([
      dateTime(sale.date),
      text(sale.recordedName ?? L.nameNotRecorded, 'wrap'),
      sale.otherName === null ? null : text(sale.otherName, 'wrap'),
      text(productStateLabel(labels, sale.productState)),
      int(sale.quantity),
      money(sale.unitPrice),
      money(sale.amount),
      text(sale.sellerName ?? labels.common.sellerUnavailable, 'wrap'),
      ...(buyers
        ? [
            sale.buyerName ? text(sale.buyerName, 'wrap') : null,
            sale.buyerContact ? text(sale.buyerContact, 'wrap') : null,
          ]
        : []),
    ]);
  }
  const lastRow = rows.length - 1;
  if (history.sales.length === 0) {
    rows.push([text(L.empty, 'muted')]);
  } else {
    rows.push(
      [],
      [
        text(L.total, 'totalText'),
        text('', 'totalText'),
        text('', 'totalText'),
        text('', 'totalText'),
        int(history.summary.quantity, 'totalInteger'),
        text('', 'totalText'),
        money(history.summary.revenue, 'totalMoney'),
        text('', 'totalText'),
        ...(buyers ? [text('', 'totalText'), text('', 'totalText')] : []),
      ],
    );
  }
  return {
    name: L.sheet,
    columns: [18, 34, 30, 18, 11, 15, 16, 24, ...(buyers ? [24, 22] : [])],
    rows,
    table: { headerRow: 0, lastRow },
  };
}

function productsSheet(
  history: MonthlyHistory,
  labels: ReportLabels,
): SheetSpec {
  const L = labels.products;
  const financials = history.rights.financials;
  const rows: Cell[][] = [
    [
      L.product,
      L.state,
      L.quantity,
      L.salesCount,
      L.revenue,
      ...(financials ? [L.gain] : []),
    ].map((h) => text(h, 'header')),
  ];
  for (const p of history.products) {
    rows.push([
      text(p.name ?? labels.common.unavailable, 'wrap'),
      text(productStateLabel(labels, p.productState)),
      int(p.quantity),
      int(p.salesCount),
      money(p.revenue),
      ...(financials
        ? [
            p.gain === null || p.gain === undefined
              ? text(labels.common.unavailable)
              : money(p.gain),
          ]
        : []),
    ]);
  }
  const lastRow = rows.length - 1;
  if (history.products.length === 0) {
    rows.push([text(L.empty, 'muted')]);
  } else {
    const gain = history.summary.estimatedGain;
    rows.push(
      [],
      [
        text(labels.sales.total, 'totalText'),
        text('', 'totalText'),
        int(history.summary.quantity, 'totalInteger'),
        int(history.summary.salesCount, 'totalInteger'),
        money(history.summary.revenue, 'totalMoney'),
        ...(financials
          ? [
              gain === null || gain === undefined
                ? text(labels.common.unavailable, 'totalText')
                : money(gain, 'totalMoney'),
            ]
          : []),
      ],
    );
  }
  return {
    name: L.sheet,
    columns: [40, 18, 16, 16, 20, ...(financials ? [20] : [])],
    rows,
    table: { headerRow: 0, lastRow },
  };
}

function sellersSheet(
  history: MonthlyHistory,
  labels: ReportLabels,
): SheetSpec {
  const L = labels.sellers;
  const rows: Cell[][] = [
    [L.seller, L.quantity, L.salesCount, L.revenue].map((h) =>
      text(h, 'header'),
    ),
  ];
  for (const s of history.sellers) {
    rows.push([
      text(s.name ?? labels.common.sellerUnavailable, 'wrap'),
      int(s.quantity),
      int(s.salesCount),
      money(s.revenue),
    ]);
  }
  const lastRow = rows.length - 1;
  if (history.sellers.length === 0) {
    rows.push([text(L.empty, 'muted')]);
  } else {
    rows.push(
      [],
      [
        text(labels.sales.total, 'totalText'),
        int(history.summary.quantity, 'totalInteger'),
        int(history.summary.salesCount, 'totalInteger'),
        money(history.summary.revenue, 'totalMoney'),
      ],
    );
  }
  return {
    name: L.sheet,
    columns: [36, 16, 16, 20],
    rows,
    table: { headerRow: 0, lastRow },
  };
}

function movementsSheet(
  history: MonthlyHistory,
  labels: ReportLabels,
): SheetSpec {
  const L = labels.movements;
  const rows: Cell[][] = [
    [
      L.date,
      L.kind,
      L.product,
      labels.sales.productState,
      L.saleDate,
      L.quantityBefore,
      L.quantityAfter,
      L.priceBefore,
      L.priceAfter,
      L.detail,
      L.actor,
    ].map((h) => text(h, 'header')),
  ];
  for (const m of history.movements) {
    rows.push([
      dateTime(m.date),
      text(m.kind === 'correction' ? L.correction : L.cancellation),
      text(m.productName ?? labels.common.unavailable, 'wrap'),
      m.productDeleted ? text(labels.common.productDeleted) : null,
      m.saleDate
        ? dateTime(m.saleDate)
        : text(labels.common.unavailable, 'muted'),
      m.quantityBefore === null ? null : int(m.quantityBefore),
      m.quantityAfter === null ? null : int(m.quantityAfter),
      m.priceBefore === null ? null : money(m.priceBefore),
      m.priceAfter === null ? null : money(m.priceAfter),
      text(movementDetail(labels, m), 'wrap'),
      text(m.actorName ?? labels.common.unavailable, 'wrap'),
    ]);
  }
  const lastRow = rows.length - 1;
  if (history.movements.length === 0) rows.push([text(L.empty, 'muted')]);
  return {
    name: L.sheet,
    columns: [18, 14, 34, 18, 18, 12, 12, 16, 16, 40, 24],
    rows,
    table: { headerRow: 0, lastRow },
  };
}

export function renderMonthlyHistoryXlsx(
  history: MonthlyHistory,
  labels: ReportLabels,
): Buffer {
  return buildWorkbook(
    [
      summarySheet(history, labels),
      salesSheet(history, labels),
      productsSheet(history, labels),
      sellersSheet(history, labels),
      movementsSheet(history, labels),
    ],
    {
      title: `${labels.documentTitle} — ${history.organization.name} — ${formatMonthLabel(labels, history.period.month)}`,
      creator: 'Stock Master',
      created: history.generatedAt,
    },
  );
}
