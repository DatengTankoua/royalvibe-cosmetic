import type { ReportLabels } from './report-labels';

/**
 * 1-16D — mise en forme des valeurs des rapports. Les dates sont lues avec
 * les accesseurs LOCAUX (`getFullYear`, `getHours`…), c'est-à-dire dans le
 * fuseau du processus API : exactement celui des bornes `monthBounds`.
 */

/** Espaces fines insécables (`Intl` fr-FR) → espace insécable simple. */
function plainSpaces(text: string): string {
  return text.replace(/[\u202f\u2009]/g, '\u00a0');
}

export function formatInteger(labels: ReportLabels, value: number): string {
  return plainSpaces(
    new Intl.NumberFormat(labels.locale, { maximumFractionDigits: 0 }).format(
      value,
    ),
  );
}

/** Montant arrondi à l'unité, comme l'écran (`fmtXof`). */
export function formatMoney(labels: ReportLabels, value: number): string {
  return `${formatInteger(labels, Math.round(value))}\u00a0${labels.currency}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatDate(date: Date): string {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatDateTime(date: Date): string {
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** « septembre 2026 » (mois `AAAA-MM`). */
export function formatMonthLabel(labels: ReportLabels, month: string): string {
  const [year, m] = month.split('-').map(Number);
  return new Date(year, m - 1, 1).toLocaleDateString(labels.locale, {
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Numéro de série Excel (jours depuis le 30/12/1899) de l'heure MURALE
 * locale : Excel ne stocke aucun fuseau, la cellule affiche donc la même
 * date et la même heure que le PDF.
 */
export function excelSerial(date: Date): number {
  const wall = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  );
  return (wall - Date.UTC(1899, 11, 30)) / 86_400_000;
}
