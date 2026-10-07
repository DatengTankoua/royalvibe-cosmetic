// 1-16G — Analyse : textes de `lib/analytics-labels.ts` (lot 1-16E) repris
// à l'identique, détails et historique mensuel. Les nombres sont formatés
// par l'appelant (`{{n}}`) ; `count` ne sert qu'au choix du pluriel.
const analyticsFr = {
  title: "Analyse",
  subtitle: "Ce qui mérite votre attention, vos ventes et ce qui se vend.",
  noPermission: "Vous n'avez pas la permission de consulter les analyses.",
  loading: "Chargement…",
  retry: "Réessayer",
  periodLabel: "Période",
  currentMonthOption: "{{label}} (en cours)",
  freshness: "Données du serveur à {{time}}",
  unsyncedNote:
    "Les ventes enregistrées hors ligne et pas encore synchronisées ne sont pas encore comptées.",
  unsyncedPending_one: "{{n}} vente locale en attente de synchronisation.",
  unsyncedPending_many: "{{n}} ventes locales en attente de synchronisation.",
  unsyncedPending_other: "{{n}} ventes locales en attente de synchronisation.",
  recordedSalesNote:
    "Montants des ventes enregistrées, pas nécessairement de l'argent encaissé.",
  watch: {
    title: "À surveiller",
    empty:
      "Rien d'urgent : aucune rupture, aucun risque estimé ni produit sans vente récente.",
    seeAll: "Voir les {{count}} produits concernés",
    andOthers_one: "et {{n}} autre produit",
    andOthers_many: "et {{n}} autres produits",
    andOthers_other: "et {{n}} autres produits",
    priceFact: "{{name}} : gain estimé {{gain}}",
    stockFact: "{{name}} : {{remaining}}",
    kinds: {
      out: {
        title: "Rupture de stock",
        reason: "Stock actuel à 0 : ce produit ne peut plus être vendu.",
        count_one: "{{n}} produit épuisé",
        count_many: "{{n}} produits épuisés",
        count_other: "{{n}} produits épuisés",
      },
      soon: {
        title: "Bientôt épuisé",
        reason:
          "Environ {{days}} jours de stock ou moins, au rythme des ventes enregistrées.",
        count_one: "{{n}} produit à réapprovisionner",
        count_many: "{{n}} produits à réapprovisionner",
        count_other: "{{n}} produits à réapprovisionner",
      },
      price: {
        title: "Prix à vérifier",
        reason:
          "Sur la période, les ventes rapportent moins que le prix d'achat actuel.",
        count_one: "{{n}} produit vendu à perte",
        count_many: "{{n}} produits vendus à perte",
        count_other: "{{n}} produits vendus à perte",
      },
      low: {
        title: "Stock faible",
        reason:
          "80 % du stock initial vendu ; pas assez de ventes pour estimer les jours restants.",
        count_one: "{{n}} produit",
        count_many: "{{n}} produits",
        count_other: "{{n}} produits",
      },
      stale: {
        title: "Sans vente récente",
        reason:
          "Aucune vente enregistrée depuis {{days}} jours, alors qu'il reste du stock.",
        count_one: "{{n}} produit",
        count_many: "{{n}} produits",
        count_other: "{{n}} produits",
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
    units_one: "{{n}} unité vendue",
    units_many: "{{n}} unités vendues",
    units_other: "{{n}} unités vendues",
    periodInProgress: "Du {{from}} au {{to}} (mois en cours)",
    periodClosed: "Du {{from}} au {{to}}",
    compareTo: "Comparé au {{from}} – {{to}}",
    compareSameElapsed: "même durée écoulée du mois précédent",
    totalPrefix: "Total du mois",
    perDayPrefix: "Par jour",
    prefixed: "{{prefix}} :",
    perDayValue: "{{value}} par jour",
    durations:
      "Mois de {{days}} jours contre {{previousDays}} jours : le total dépend de la durée ; le rythme se lit « par jour ».",
    previousZero: "contre {{amount}} : pas de pourcentage",
    changeUp: "+{{pct}} %",
    changeDown: "−{{pct}} %",
    changeFlat: "stable",
    previousValue: "avant : {{value}}",
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
    trendSummary_one: "{{total}} sur {{n}} jour ; meilleur jour : {{best}}.",
    trendSummary_many: "{{total}} sur {{n}} jours ; meilleur jour : {{best}}.",
    trendSummary_other: "{{total}} sur {{n}} jours ; meilleur jour : {{best}}.",
    trendNone_one: "Aucune vente sur {{n}} jour.",
    trendNone_many: "Aucune vente sur {{n}} jours.",
    trendNone_other: "Aucune vente sur {{n}} jours.",
    bestDay: "{{date}} ({{amount}})",
    barTitle_one: "{{date}} : {{amount}} · {{n}} vente",
    barTitle_many: "{{date}} : {{amount}} · {{n}} ventes",
    barTitle_other: "{{date}} : {{amount}} · {{n}} ventes",
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
    windowNote:
      "Rythme calculé sur les {{days}} derniers jours terminés ({{from}} – {{to}}), au rythme des ventes enregistrées. Les jours où le produit manquait, la saison et les délais fournisseurs ne sont pas connus.",
    sections: {
      out: "Rupture constatée (stock à 0)",
      soon: "Risque estimé de rupture prochaine",
      low: "Stock faible (seuil des 80 %)",
      stale: "Aucune vente enregistrée récemment",
      recent: "Ajoutés récemment, pas encore vendus",
      price: "Prix à vérifier",
    },
    sectionCount: "{{title}} ({{n}})",
    remaining: "{{n}} en stock",
    daysLeft: "≈ {{days}} j de stock",
    perDay: "{{avg}} vendus / jour",
    notEnough: "Pas assez de ventes pour estimer",
    invalidQuantities: "Quantités de vente invalides : pas d'estimation",
    staleLabel: "Aucune vente enregistrée depuis {{days}} jours",
    recentLabel: "Ajouté pendant la période observée",
    priceFacts_one:
      "{{revenue}} de ventes pour {{n}} unité ; prix d'achat actuel {{cost}} l'unité ; gain estimé {{gain}}.",
    priceFacts_many:
      "{{revenue}} de ventes pour {{n}} unités ; prix d'achat actuel {{cost}} l'unité ; gain estimé {{gain}}.",
    priceFacts_other:
      "{{revenue}} de ventes pour {{n}} unités ; prix d'achat actuel {{cost}} l'unité ; gain estimé {{gain}}.",
    shownOf_one: "{{shown}} affiché sur {{total}}",
    shownOf_many: "{{shown}} affichés sur {{total}}",
    shownOf_other: "{{shown}} affichés sur {{total}}",
    showMore_one: "Afficher le suivant",
    showMore_many: "Afficher les {{count}} suivants",
    showMore_other: "Afficher les {{count}} suivants",
    loadError: "La suite de la liste n'a pas pu être chargée.",
    noneInSection: "Aucun produit.",
  },
  details: {
    title: "Détails",
    open: "Produits, vendeurs et historique",
    summary: "{{title}} : {{open}}",
    allProducts: "Tous les produits vendus · {{month}}",
    product: "Produit",
    sold: "Vendus",
    amount: "Montant",
    estimatedGain: "Gain estimé",
    currentStock: "Stock actuel",
    unknownCost: "Coût d'achat inconnu (produits supprimés)",
    sellersTitle: "Ventes par vendeur · {{month}}",
    sellerSales_one: "{{n}} vente",
    sellerSales_many: "{{n}} ventes",
    sellerSales_other: "{{n}} ventes",
    sellerUnits_one: "{{n}} unité",
    sellerUnits_many: "{{n}} unités",
    sellerUnits_other: "{{n}} unités",
    historyTitle: "Historique par mois",
    month: "Mois",
    sales: "Ventes",
    units: "Unités",
    sinceStart: "Depuis le début",
    salesAmount: "Montant des ventes",
    salesCount: "Nombre de ventes",
    products: "Produits",
    capital: "Capital investi",
    profitAll: "Bénéfice estimé (toutes périodes)",
  },
  monthly: {
    title: "Historique mensuel",
    text: "Téléchargez toutes les ventes d'un mois, avec un bilan et des récapitulatifs par produit et par vendeur.",
    loading: "Chargement des mois disponibles…",
    month: "Mois",
    inProgress: " (en cours)",
    noSales: "aucune vente",
    salesCount_one: "{{n}} vente",
    salesCount_many: "{{n}} ventes",
    salesCount_other: "{{n}} ventes",
    option: "{{month}}{{inProgress}} — {{sales}}",
    preparing: "Préparation…",
    download: "Télécharger en {{format}}",
    downloaded: "Fichier {{format}} de {{month}} téléchargé.",
    emptyMonth:
      "Aucune vente enregistrée pour ce mois : le fichier contiendra seulement le bilan, à zéro.",
    currentMonth:
      "Mois en cours : le fichier reflète la situation au moment du téléchargement.",
    offline: "Le téléchargement nécessite une connexion Internet.",
    pendingNote:
      "Les ventes encore en attente de synchronisation sur un appareil ne figurent pas dans le rapport.",
    pendingDevice_one:
      "Cet appareil en a {{n}} : synchronisez-la avant de télécharger.",
    pendingDevice_many:
      "Cet appareil en a {{n}} : synchronisez-les avant de télécharger.",
    pendingDevice_other:
      "Cet appareil en a {{n}} : synchronisez-les avant de télécharger.",
    timeZone:
      "Dates et limites du mois : fuseau {{timeZone}}, comme dans les analyses.",
    errors: {
      generic: "Le fichier n'a pas pu être préparé. Réessayez.",
      network:
        "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.",
      subscription:
        "L'abonnement de ce commerce n'est pas actif : le téléchargement est indisponible.",
      forbidden:
        "Votre rôle ou vos droits actuels ne permettent pas de télécharger cet historique.",
      monthInvalid: "Ce mois n'est pas disponible.",
      pdfCharacters:
        "Certains noms ne peuvent pas être reproduits fidèlement en PDF. Téléchargez la version Excel.",
      rateLimited:
        "Trop de téléchargements d'historique en peu de temps. Réessayez plus tard.",
      busy: "D'autres rapports sont en cours de préparation. Réessayez dans quelques secondes.",
      dataChanged:
        "Des ventes ont changé pendant la préparation. Réessayez dans un instant.",
      server:
        "Le serveur n'a pas pu préparer le fichier. Réessayez dans quelques instants.",
    },
  },
} as const;

export default analyticsFr;
