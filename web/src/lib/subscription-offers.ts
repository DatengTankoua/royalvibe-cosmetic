// 1-14C.2 — Offre commerciale Stock Master : UNE offre, quatre durées.
//
// Présentation UNIQUEMENT (page publique, espace Abonnement). Ces montants
// ne servent JAMAIS à attribuer une période depuis le navigateur : seule une
// attribution serveur (script opérateur, puis paiement en 1-14D) ouvre
// l'accès. Devise XAF, affichée « FCFA ».

export type SubscriptionTerm =
  "monthly" | "quarterly" | "semiannual" | "annual";

// 1-16G : libellés (« 1 mois », « 2 mois offerts »…) dans le namespace
// `subscription` (`offers.term.*`, `offers.highlight.*`), jamais ici.
export interface SubscriptionOffer {
  term: SubscriptionTerm;
  months: number;
  /** Montant TOTAL à payer pour la durée choisie (XAF). */
  totalXaf: number;
  /** Économie par rapport à `months` paiements mensuels (XAF). */
  savingXaf: number;
  /** Mention complémentaire validée : économie ou « 2 mois offerts ». */
  highlight?: "saving" | "freeMonths";
}

/** Prix mensuel de référence (XAF). */
export const MONTHLY_PRICE_XAF = 3000;

/** Durée de l'essai gratuit (jours), attribué par le serveur à l'inscription. */
export const TRIAL_DAYS = 7;

export const SUBSCRIPTION_OFFERS: readonly SubscriptionOffer[] = [
  {
    term: "monthly",
    months: 1,
    totalXaf: 3000,
    savingXaf: 0,
  },
  {
    term: "quarterly",
    months: 3,
    totalXaf: 8500,
    savingXaf: 500,
    highlight: "saving",
  },
  {
    term: "semiannual",
    months: 6,
    totalXaf: 16000,
    savingXaf: 2000,
    highlight: "saving",
  },
  {
    term: "annual",
    months: 12,
    totalXaf: 30000,
    savingXaf: 6000,
    highlight: "freeMonths",
  },
];

/** Équivalent mensuel ARRONDI, toujours présenté comme tel. */
export function monthlyEquivalentXaf(offer: SubscriptionOffer): number {
  return Math.round(offer.totalXaf / offer.months);
}

/** Durée connue du serveur, sinon `null` (libellé générique « — »). */
export function knownTerm(
  term: string | null | undefined,
): SubscriptionTerm | null {
  return SUBSCRIPTION_OFFERS.find((offer) => offer.term === term)?.term ?? null;
}

// Chemin relatif : ce module est aussi chargé par un test de l'API
// (`subscription-pricing.spec.ts`), sans l'alias `@/`.
/** Montant XAF formaté « 30 000 FCFA » (fr) ou « 30,000 FCFA » (en). */
export { formatFcfa } from "../i18n/format";

// Cohérence vérifiée au chargement du module : toute modification de tarif
// incohérente (économie mal calculée) échoue au build/prérendu.
for (const offer of SUBSCRIPTION_OFFERS) {
  if (offer.months * MONTHLY_PRICE_XAF - offer.totalXaf !== offer.savingXaf) {
    throw new Error(`Offre ${offer.term} incohérente.`);
  }
}
