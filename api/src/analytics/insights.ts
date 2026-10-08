import { stockLowReached } from '../push/stock-thresholds';
import { monthBounds } from './month-range';
import {
  INSIGHT_THRESHOLDS,
  type InsightThresholds,
} from './insight-thresholds';

/**
 * 1-16E — calculs PURS de l'aide à la décision (aucun accès base) : rythme
 * des ventes, classement du stock, produits sans vente récente, période de
 * comparaison et cartes « À surveiller ». Les dates civiles sont celles du
 * FUSEAU DU PROCESSUS API, comme les bornes mensuelles (1-16D).
 *
 * Les décisions comparent toujours les valeurs NON arrondies ; l'arrondi
 * appartient à l'affichage.
 */

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Minuit (fuseau du processus) du jour civil de `date`. */
export function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Minuit du jour civil situé `days` jours après celui de `date`. */
export function addLocalDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Jours civils entre deux minuits (arrondi : absorbe les changements d'heure). */
export function civilDaysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** `AAAA-MM-JJ` du jour civil de `date`. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function parseLocalDayKey(key: string): Date | null {
  const match = DAY_KEY.exec(key);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Mois `AAAA-MM` (fuseau du processus) de `date`. */
export function localMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Fenêtre d'observation : les N derniers jours civils TERMINÉS. */
export function observationWindow(
  now: Date,
  days: number = INSIGHT_THRESHOLDS.observationWindowDays,
): { start: Date; end: Date; days: number } {
  const end = startOfLocalDay(now);
  return { start: addLocalDays(end, -days), end, days };
}

/** Ventes d'un produit sur un jour civil (agrégées côté base). */
export interface ProductDayRow {
  productId: string;
  day: string;
  /** Somme des quantités valides (nombre fini > 0). */
  units: number;
  /** Ventes dont la quantité n'est pas valide. */
  invalid: number;
}

export type SalesRateEstimate =
  | {
      estimable: true;
      observedDays: number;
      distinctSaleDays: number;
      unitsSold: number;
      dailyAverage: number;
      /** `null` si le stock actuel n'est pas un nombre valide. */
      daysLeft: number | null;
    }
  | {
      estimable: false;
      reason: 'insufficient_history' | 'invalid_quantities';
      observedDays: number;
      distinctSaleDays: number;
      unitsSold: number;
    };

/**
 * Rythme des ventes nettes enregistrées d'un produit.
 *
 * L'observation commence au plus tard des trois : début de fenêtre, jour
 * d'ajout du produit, jour de création du commerce (le jour d'ajout compte :
 * les ventes de ce jour sont prises en compte). Les ventes antérieures à ce
 * début (données migrées) sont ignorées.
 *
 * moyenne journalière = quantité vendue / jours d'observation disponibles
 * jours estimés restants = stock actuel / moyenne journalière
 *
 * Estimation seulement avec au moins `minObservationDays` jours observés,
 * `minDistinctSaleDays` dates de vente distinctes, des quantités valides et
 * une moyenne positive.
 */
export function estimateSalesRate(input: {
  remainingQuantity: number;
  window: { start: Date; end: Date };
  productCreatedAt?: Date | null;
  organizationCreatedAt?: Date | null;
  days: readonly ProductDayRow[];
  thresholds?: InsightThresholds;
}): SalesRateEstimate {
  const t = input.thresholds ?? INSIGHT_THRESHOLDS;
  const starts = [input.window.start];
  for (const at of [input.productCreatedAt, input.organizationCreatedAt]) {
    if (at instanceof Date && !Number.isNaN(at.getTime())) {
      starts.push(startOfLocalDay(at));
    }
  }
  const observationStart = new Date(
    Math.max(...starts.map((d) => d.getTime())),
  );
  const observedDays = Math.max(
    0,
    civilDaysBetween(observationStart, input.window.end),
  );

  let unitsSold = 0;
  let invalid = 0;
  const saleDays = new Set<string>();
  for (const row of input.days) {
    const day = parseLocalDayKey(row.day);
    if (!day || day < observationStart || day >= input.window.end) continue;
    invalid += row.invalid;
    if (Number.isFinite(row.units) && row.units > 0) {
      unitsSold += row.units;
      saleDays.add(row.day);
    } else if (row.units !== 0) {
      invalid += 1;
    }
  }
  const base = { observedDays, distinctSaleDays: saleDays.size, unitsSold };
  if (invalid > 0) {
    return { estimable: false, reason: 'invalid_quantities', ...base };
  }
  const dailyAverage = observedDays > 0 ? unitsSold / observedDays : 0;
  if (
    observedDays < t.minObservationDays ||
    saleDays.size < t.minDistinctSaleDays ||
    !Number.isFinite(dailyAverage) ||
    dailyAverage <= 0
  ) {
    return { estimable: false, reason: 'insufficient_history', ...base };
  }
  const remaining = input.remainingQuantity;
  // stock / (quantité / jours) écrit stock × jours / quantité : même valeur,
  // sans erreur d'arrondi intermédiaire (7 jours exacts restent 7, pas
  // 7,000000000000001, à la comparaison avec le seuil).
  const daysLeft =
    Number.isFinite(remaining) && remaining >= 0
      ? (remaining * observedDays) / unitsSold
      : null;
  return { estimable: true, ...base, dailyAverage, daysLeft };
}

export type StockSignal = 'out' | 'soon' | 'low';

/**
 * - `out` : rupture constatée (stock actuel nul) ;
 * - `soon` : risque estimé de rupture prochaine (≤ `soonStockoutDays`
 *   jours estimés, valeur non arrondie) ;
 * - `low` : stock faible selon le seuil existant (80 % du stock initial
 *   consommé, 1-16A.1), UNIQUEMENT lorsque l'estimation manque.
 */
export function classifyStock(
  product: { remainingQuantity: number; initialQuantity: number },
  estimate: SalesRateEstimate,
  thresholds: InsightThresholds = INSIGHT_THRESHOLDS,
): StockSignal | null {
  const remaining = product.remainingQuantity;
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  if (remaining === 0) return 'out';
  if (estimate.estimable) {
    return estimate.daysLeft !== null &&
      estimate.daysLeft <= thresholds.soonStockoutDays
      ? 'soon'
      : null;
  }
  return stockLowReached(product.initialQuantity, remaining) ? 'low' : null;
}

/**
 * Produit disponible, stock actuel positif, AUCUNE vente enregistrée sur la
 * fenêtre : `stale` s'il a été ajouté avant le début de la fenêtre, `recent`
 * sinon (récemment ajouté, jamais présenté comme un problème). Rien n'est
 * affirmé sur sa disponibilité réelle pendant la période.
 */
export function noRecentSaleKind(input: {
  remainingQuantity: number;
  productCreatedAt?: Date | null;
  windowStart: Date;
  salesInWindow: number;
}): 'stale' | 'recent' | null {
  if (!(input.remainingQuantity > 0) || input.salesInWindow > 0) return null;
  const created = input.productCreatedAt;
  // Date d'ajout inconnue : traité comme ancien (aucune date inventée).
  if (!(created instanceof Date) || Number.isNaN(created.getTime())) {
    return 'stale';
  }
  return created < input.windowStart ? 'stale' : 'recent';
}

export type ComparisonUnavailableReason = 'before_creation' | 'unequal_length';

export type ComparisonWindow =
  | {
      available: true;
      start: Date;
      end: Date;
      /** Période en cours : même durée écoulée du mois précédent. */
      partial: boolean;
      /** Mois précédent entier (mois choisi terminé). */
      month?: string;
    }
  | {
      available: false;
      reason: ComparisonUnavailableReason;
      start: Date;
      end: Date;
    };

/** `AAAA-MM` du mois précédant `month`. */
export function previousMonthKey(month: string): string {
  const { start } = monthBounds(month);
  return localMonthKey(new Date(start.getFullYear(), start.getMonth() - 1, 1));
}

/**
 * Période comparable au mois choisi :
 * - mois terminé → mois précédent entier ;
 * - mois en cours → début du mois précédent + même durée écoulée (jamais un
 *   mois entier face à un mois commencé) ; si cette durée dépasse le mois
 *   précédent (ex. 30 mars face à février), aucune comparaison ;
 * - début de la période précédente antérieur à la création du commerce →
 *   aucune comparaison (période non observée).
 */
export function comparisonWindow(
  month: string,
  now: Date,
  organizationCreatedAt?: Date | null,
): ComparisonWindow {
  const current = monthBounds(month);
  const previousMonth = previousMonthKey(month);
  const previous = monthBounds(previousMonth);
  const inProgress = now >= current.start && now < current.end;
  const end = inProgress
    ? new Date(
        previous.start.getTime() + (now.getTime() - current.start.getTime()),
      )
    : previous.end;
  const created =
    organizationCreatedAt instanceof Date &&
    !Number.isNaN(organizationCreatedAt.getTime())
      ? startOfLocalDay(organizationCreatedAt)
      : null;
  if (created && previous.start < created) {
    return {
      available: false,
      reason: 'before_creation',
      start: previous.start,
      end,
    };
  }
  if (inProgress && end > previous.end) {
    return {
      available: false,
      reason: 'unequal_length',
      start: previous.start,
      end: previous.end,
    };
  }
  return inProgress
    ? { available: true, start: previous.start, end, partial: true }
    : {
        available: true,
        start: previous.start,
        end,
        partial: false,
        month: previousMonth,
      };
}

/** Évolution en % ; `null` si la période précédente est à zéro (jamais ∞). */
export function changePercent(
  current: number,
  previous: number,
): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export type PriorityKind = 'out' | 'soon' | 'price' | 'low' | 'stale';

/** Ordre de gravité des cartes « À surveiller ». */
export const PRIORITY_ORDER: readonly PriorityKind[] = Object.freeze([
  'out',
  'soon',
  'price',
  'low',
  'stale',
]);

export interface PriorityCard<T extends { productId: string }> {
  kind: PriorityKind;
  /** Produits de cette priorité (tous, pas une page). */
  count: number;
  /** Aperçu : le produit le plus urgent (la liste se lit par pages). */
  items: T[];
}

/**
 * 1-16E — priorité UNIQUE : chaque produit n'est gardé que dans la liste la
 * plus grave (`PRIORITY_ORDER`) ; l'ordre de chaque liste est conservé. Les
 * cartes, les listes détaillées et leurs pages partagent ce résultat :
 * aucun produit compté ou affiché deux fois.
 */
export function assignPrimaryPriority<T extends { productId: string }>(
  lists: Partial<Record<PriorityKind, readonly T[]>>,
): Partial<Record<PriorityKind, T[]>> {
  const seen = new Set<string>();
  const result: Partial<Record<PriorityKind, T[]>> = {};
  for (const kind of PRIORITY_ORDER) {
    const list = lists[kind];
    if (!list) continue;
    result[kind] = list.filter((item) => !seen.has(item.productId));
    for (const item of result[kind]) seen.add(item.productId);
  }
  return result;
}

/**
 * Au plus `maxPriorities` cartes, par gravité, sur les listes à priorité
 * unique (`assignPrimaryPriority`, appliquée ici aussi par sûreté).
 */
export function buildPriorities<T extends { productId: string }>(
  lists: Partial<Record<PriorityKind, readonly T[]>>,
  thresholds: InsightThresholds = INSIGHT_THRESHOLDS,
): PriorityCard<T>[] {
  const primary = assignPrimaryPriority(lists);
  const cards: PriorityCard<T>[] = [];
  for (const kind of PRIORITY_ORDER) {
    const items = primary[kind];
    if (!items || items.length === 0) continue;
    if (cards.length >= thresholds.maxPriorities) break;
    cards.push({ kind, count: items.length, items: items.slice(0, 1) });
  }
  return cards;
}

/** Page d'une liste : `[offset, offset + limit[`, dans l'ordre stable. */
export function pageOf<T>(
  items: readonly T[],
  offset: number,
  limit: number,
): { count: number; offset: number; limit: number; items: T[] } {
  return {
    count: items.length,
    offset,
    limit,
    items: items.slice(offset, offset + limit),
  };
}
