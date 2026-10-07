/**
 * 1-16D — bornes d'un mois civil `AAAA-MM`, extraites telles quelles de
 * `AnalyticsService.monthMatch` (1-11C.1) pour être partagées par l'Analyse
 * et l'historique mensuel exportable : `new Date(année, mois, 1)`, donc
 * minuit dans le FUSEAU DU PROCESSUS API (début inclus, fin exclue).
 * Aucun changement de sens : mêmes bornes, même repli sur `createdAt`.
 */
export function monthBounds(month: string): { start: Date; end: Date } {
  const [year, m] = month.split('-').map(Number);
  return { start: new Date(year, m - 1, 1), end: new Date(year, m, 1) };
}

/**
 * Filtre des ventes d'un mois : `occurredAt` (heure réelle de la vente) ;
 * les ventes antérieures à ce champ (`null` couvre aussi « absent »)
 * retombent sur `createdAt`.
 */
export function saleMonthMatch(month: string): Record<string, unknown> {
  const { start, end } = monthBounds(month);
  return saleRangeMatch(start, end);
}

/**
 * 1-16E — même filtre sur un intervalle quelconque `[start, end[` (période
 * de comparaison, fenêtre d'observation). `saleMonthMatch` en est le cas
 * mensuel : bornes et repli identiques.
 */
export function saleRangeMatch(
  start: Date,
  end: Date,
): Record<string, unknown> {
  const range = { $gte: start, $lt: end };
  return {
    $or: [{ occurredAt: range }, { occurredAt: null, createdAt: range }],
  };
}

/**
 * Fuseau réellement utilisé par ces bornes : celui du processus API
 * (variable `TZ`, sinon fuseau du système ; souvent UTC en conteneur).
 * Même source que le bilan mensuel 1-16A.1.
 */
export function processTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/**
 * 1-16D — fuseau des bornes mensuelles, appliqué au démarrage de l'API.
 * `TZ` (ex. `Africa/Douala`) est lu par Node au lancement ; un nom inconnu
 * ferait SILENCIEUSEMENT basculer en UTC (vérifié dans l'image Alpine) :
 * il est donc validé, réaffecté, puis le fuseau effectif est contrôlé ;
 * sinon, démarrage refusé. Sans `TZ`, rien ne change (fuseau du système).
 */
export function configureProcessTimeZone(
  env: { TZ?: string } = process.env,
): string {
  const requested = env.TZ?.trim();
  if (!requested) return processTimeZone();
  let canonical: string | undefined;
  try {
    canonical = new Intl.DateTimeFormat('en-US', {
      timeZone: requested,
    }).resolvedOptions().timeZone;
  } catch {
    canonical = undefined;
  }
  if (!canonical) {
    throw new Error(`TZ invalide : « ${requested} » (nom IANA attendu).`);
  }
  process.env.TZ = requested;
  const effective = processTimeZone();
  if (effective !== canonical) {
    throw new Error(
      `TZ « ${requested} » non appliqué (fuseau effectif : ${effective}).`,
    );
  }
  return effective;
}
