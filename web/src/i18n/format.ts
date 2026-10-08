import { intlLocale, type Locale } from "./settings";

// 1-16G — Formats d'affichage selon la langue. Seule la présentation
// change : la devise reste le franc CFA (« FCFA »), le fuseau et les bornes
// des périodes viennent du serveur et ne dépendent jamais de la langue.

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(intlLocale(locale), options);
    cache.set(key, format);
  }
  return format;
}

export function dateFormat(
  locale: Locale,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(intlLocale(locale), options);
    cache.set(key, format);
  }
  return format;
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions,
): string {
  return numberFormat(locale, options).format(value);
}

/** Montant XAF : « 30 000 FCFA » (fr) ou « 30,000 FCFA » (en). */
export function formatFcfa(amount: number, locale: Locale): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return `${numberFormat(locale, { maximumFractionDigits: 0 }).format(safe)} FCFA`;
}

/** Date courte : 07/10/2026 (fr) ou 07/10/2026 (en-GB). */
export function formatDate(
  value: string | number | Date,
  locale: Locale,
): string {
  return dateFormat(locale, { dateStyle: "short" }).format(new Date(value));
}

/** Date et heure courtes, équivalent de `toLocaleString()`. */
export function formatDateTime(
  value: string | number | Date,
  locale: Locale,
): string {
  return dateFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

/** « octobre 2026 » / « October 2026 » pour un mois `AAAA-MM`. */
export function formatMonth(month: string, locale: Locale): string {
  const [year, m] = month.split("-");
  return dateFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(Number(year), Number(m) - 1),
  );
}
