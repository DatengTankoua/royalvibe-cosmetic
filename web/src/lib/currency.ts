/** Taux fixe officiel : 1 EUR = 655.957 XOF (parité fixe depuis 1999) */
export const EUR_TO_XOF = 655.957;

export function eurToXof(eur: number): number {
  return Math.round(eur * EUR_TO_XOF);
}

export function xofToEur(xof: number): number {
  return xof / EUR_TO_XOF;
}

export function fmtXof(n: number): string {
  const safe = isNaN(n) || !isFinite(n) ? 0 : n;
  const formatted = new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(safe);
  return `${formatted} FCFA`;
}

export function fmtEur(n: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}
