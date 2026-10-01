// 1-14C.2 — Offre commerciale Stock Master : UNE offre, quatre durées.
//
// Présentation UNIQUEMENT (page publique, espace Abonnement). Ces montants
// ne servent JAMAIS à attribuer une période depuis le navigateur : seule une
// attribution serveur (script opérateur, puis paiement en 1-14D) ouvre
// l'accès. Devise XAF, affichée « FCFA ».

export type SubscriptionTerm =
  "monthly" | "quarterly" | "semiannual" | "annual";

export interface SubscriptionOffer {
  term: SubscriptionTerm;
  months: number;
  label: string;
  /** Montant TOTAL à payer pour la durée choisie (XAF). */
  totalXaf: number;
  /** Économie par rapport à `months` paiements mensuels (XAF). */
  savingXaf: number;
  /** Mention complémentaire validée (ex. « 2 mois offerts »). */
  highlight?: string;
}

/** Prix mensuel de référence (XAF). */
export const MONTHLY_PRICE_XAF = 3000;

/** Durée de l'essai gratuit (jours), attribué par le serveur à l'inscription. */
export const TRIAL_DAYS = 7;

export const SUBSCRIPTION_OFFERS: readonly SubscriptionOffer[] = [
  {
    term: "monthly",
    months: 1,
    label: "1 mois",
    totalXaf: 3000,
    savingXaf: 0,
  },
  {
    term: "quarterly",
    months: 3,
    label: "3 mois",
    totalXaf: 8500,
    savingXaf: 500,
    highlight: "500 FCFA d'économie",
  },
  {
    term: "semiannual",
    months: 6,
    label: "6 mois",
    totalXaf: 16000,
    savingXaf: 2000,
    highlight: "2000 FCFA d'économie",
  },
  {
    term: "annual",
    months: 12,
    label: "12 mois",
    totalXaf: 30000,
    savingXaf: 6000,
    highlight: "2 mois offerts",
  },
];

/** Équivalent mensuel ARRONDI, toujours présenté comme tel. */
export function monthlyEquivalentXaf(offer: SubscriptionOffer): number {
  return Math.round(offer.totalXaf / offer.months);
}

/** Libellé d'une durée connue du serveur (`term`), sinon générique. */
export function termLabel(term: string | null | undefined): string {
  return SUBSCRIPTION_OFFERS.find((offer) => offer.term === term)?.label ?? "—";
}

/** Montant XAF formaté « 30 000 FCFA » (espace insécable fine, fr-FR). */
export function formatFcfa(amount: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(amount)} FCFA`;
}

// Cohérence vérifiée au chargement du module : toute modification de tarif
// incohérente (économie mal calculée) échoue au build/prérendu.
for (const offer of SUBSCRIPTION_OFFERS) {
  if (offer.months * MONTHLY_PRICE_XAF - offer.totalXaf !== offer.savingXaf) {
    throw new Error(`Offre ${offer.term} incohérente.`);
  }
}
