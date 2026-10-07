// 1-16E — libellés de la page Analyse, regroupés pour la traduction
// (lot suivant) : seul le français est rempli ; l'anglais reprendra la même
// forme `AnalyticsLabels`. Aucun texte d'interface de l'aide à la décision
// n'est écrit ailleurs.

export type AnalyticsLocale = "fr";

const plural = (n: number, one: string, many: string) =>
  `${new Intl.NumberFormat("fr-FR").format(n)} ${n > 1 ? many : one}`;

const FR = {
  title: "Analyse",
  subtitle: "Ce qui mérite votre attention, vos ventes et ce qui se vend.",
  noPermission: "Vous n'avez pas la permission de consulter les analyses.",
  loading: "Chargement…",
  retry: "Réessayer",
  periodLabel: "Période",
  currentMonthOption: (label: string) => `${label} (en cours)`,
  freshness: (time: string) => `Données du serveur à ${time}`,
  unsyncedNote:
    "Les ventes enregistrées hors ligne et pas encore synchronisées ne sont pas encore comptées.",
  unsyncedPending: (n: number) =>
    `${plural(n, "vente locale", "ventes locales")} en attente de synchronisation.`,
  recordedSalesNote:
    "Montants des ventes enregistrées, pas nécessairement de l'argent encaissé.",

  watch: {
    title: "À surveiller",
    empty:
      "Rien d'urgent : aucune rupture, aucun risque estimé ni produit sans vente récente.",
    seeAll: (n: number) => `Voir les ${n} produits concernés`,
    andOthers: (n: number) =>
      n > 0 ? `et ${plural(n, "autre produit", "autres produits")}` : "",
    kinds: {
      out: {
        title: "Rupture de stock",
        reason: "Stock actuel à 0 : ce produit ne peut plus être vendu.",
        count: (n: number) => plural(n, "produit épuisé", "produits épuisés"),
      },
      soon: {
        title: "Bientôt épuisé",
        reason: (days: number) =>
          `Environ ${days} jours de stock ou moins, au rythme des ventes enregistrées.`,
        count: (n: number) =>
          plural(
            n,
            "produit à réapprovisionner",
            "produits à réapprovisionner",
          ),
      },
      price: {
        title: "Prix à vérifier",
        reason:
          "Sur la période, les ventes rapportent moins que le prix d'achat actuel.",
        count: (n: number) =>
          plural(n, "produit vendu à perte", "produits vendus à perte"),
      },
      low: {
        title: "Stock faible",
        reason:
          "80 % du stock initial vendu ; pas assez de ventes pour estimer les jours restants.",
        count: (n: number) => plural(n, "produit", "produits"),
      },
      stale: {
        title: "Sans vente récente",
        reason: (days: number) =>
          `Aucune vente enregistrée depuis ${days} jours, alors qu'il reste du stock.`,
        count: (n: number) => plural(n, "produit", "produits"),
      },
    },
    actions: {
      restock: "Ajouter du stock",
      reviewPrice: "Revoir le prix",
      viewProduct: "Voir le produit",
    },
  },

  sales: {
    title: "Vos ventes",
    revenue: "Montant des ventes",
    count: "Nombre de ventes",
    gain: "Gain estimé",
    gainUnknown: "Coût d'achat inconnu pour certains produits supprimés.",
    gainHint:
      "Ventes moins le prix d'achat actuel des produits vendus. Ce n'est pas un bénéfice comptable.",
    units: (n: number) => plural(n, "unité vendue", "unités vendues"),
    periodInProgress: (from: string, to: string) =>
      `Du ${from} au ${to} (mois en cours)`,
    periodClosed: (from: string, to: string) => `Du ${from} au ${to}`,
    compareTo: (from: string, to: string) => `Comparé au ${from} – ${to}`,
    compareSameElapsed: "même durée écoulée du mois précédent",
    totalPrefix: "Total du mois",
    perDayPrefix: "Par jour",
    perDayValue: (value: string) => `${value} par jour`,
    durations: (days: number, previousDays: number) =>
      `Mois de ${days} jours contre ${previousDays} jours : le total dépend de la durée ; le rythme se lit « par jour ».`,
    previousZero: (amount: string) => `contre ${amount} : pas de pourcentage`,
    changeUp: (pct: string) => `+${pct} %`,
    changeDown: (pct: string) => `−${pct} %`,
    changeFlat: "stable",
    previousValue: (value: string) => `avant : ${value}`,
    noComparison: {
      before_creation:
        "Pas de comparaison : le commerce n'existait pas encore au début de la période précédente.",
      unequal_length:
        "Pas de comparaison aujourd'hui : le mois précédent est plus court que la durée déjà écoulée.",
      none: "Pas de période comparable.",
    },
  },

  sells: {
    title: "Ce qui se vend",
    trendTitle: "Ventes par jour",
    trendSummary: (total: string, best: string | null, days: number) =>
      best
        ? `${total} sur ${plural(days, "jour", "jours")} ; meilleur jour : ${best}.`
        : `Aucune vente sur ${plural(days, "jour", "jours")}.`,
    trendTable: "Voir les chiffres jour par jour",
    day: "Jour",
    amount: "Montant",
    salesCount: "Ventes",
    topTitle: "Les 5 produits qui rapportent le plus",
    topEmpty: "Aucune vente sur cette période.",
    product: "Produit",
    quantity: "Quantité",
    currentStock: "Stock actuel",
    currentStockHint:
      "Stock d'aujourd'hui, quelle que soit la période choisie.",
    deleted: "supprimé",
    unnamed: "Nom non conservé",
  },

  stock: {
    title: "Stock actuel et rythme des ventes",
    windowNote: (days: number, from: string, to: string) =>
      `Rythme calculé sur les ${days} derniers jours terminés (${from} – ${to}), au rythme des ventes enregistrées. Les jours où le produit manquait, la saison et les délais fournisseurs ne sont pas connus.`,
    sections: {
      out: "Rupture constatée (stock à 0)",
      soon: "Risque estimé de rupture prochaine",
      low: "Stock faible (seuil des 80 %)",
      stale: "Aucune vente enregistrée récemment",
      recent: "Ajoutés récemment, pas encore vendus",
      price: "Prix à vérifier",
    },
    remaining: (n: number) =>
      `${new Intl.NumberFormat("fr-FR").format(n)} en stock`,
    daysLeft: (days: string) => `≈ ${days} j de stock`,
    perDay: (avg: string) => `${avg} vendus / jour`,
    notEnough: "Pas assez de ventes pour estimer",
    invalidQuantities: "Quantités de vente invalides : pas d'estimation",
    staleLabel: (days: number) =>
      `Aucune vente enregistrée depuis ${days} jours`,
    recentLabel: "Ajouté pendant la période observée",
    priceFacts: (revenue: string, units: number, cost: string, gain: string) =>
      `${revenue} de ventes pour ${plural(units, "unité", "unités")} ; prix d'achat actuel ${cost} l'unité ; gain estimé ${gain}.`,
    shownOf: (shown: number, total: number) =>
      `${new Intl.NumberFormat("fr-FR").format(shown)} affiché${shown > 1 ? "s" : ""} sur ${new Intl.NumberFormat("fr-FR").format(total)}`,
    showMore: (n: number) =>
      n > 1 ? `Afficher les ${n} suivants` : "Afficher le suivant",
    loadError: "La suite de la liste n'a pas pu être chargée.",
    noneInSection: "Aucun produit.",
  },

  details: {
    title: "Détails",
    open: "Produits, vendeurs et historique",
  },
} as const;

export type AnalyticsLabels = typeof FR;

export const ANALYTICS_LABELS: Record<AnalyticsLocale, AnalyticsLabels> = {
  fr: FR,
};

export function analyticsLabels(
  locale: AnalyticsLocale = "fr",
): AnalyticsLabels {
  return ANALYTICS_LABELS[locale];
}
