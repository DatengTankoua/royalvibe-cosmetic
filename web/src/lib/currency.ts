import { DEFAULT_LOCALE, intlLocale, type Locale } from "@/i18n/settings";

/** Taux fixe officiel : 1 EUR = 655.957 XOF (parité fixe depuis 1999) */
export const EUR_TO_XOF = 655.957;

export function eurToXof(eur: number): number {
  return Math.round(eur * EUR_TO_XOF);
}

export function xofToEur(xof: number): number {
  return xof / EUR_TO_XOF;
}

// 1-16G : présentation selon la langue (séparateurs) ; la devise et les
// montants ne changent jamais.
export function fmtXof(n: number, locale: Locale = DEFAULT_LOCALE): string {
  const safe = isNaN(n) || !isFinite(n) ? 0 : n;
  const formatted = new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(safe);
  return `${formatted} FCFA`;
}

export function fmtEur(n: number, locale: Locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
