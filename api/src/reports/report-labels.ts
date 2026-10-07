/**
 * 1-16D — libellés de l'historique mensuel exportable, regroupés ici pour
 * préparer la traduction anglaise : une langue = un objet de même forme
 * (`ReportLabels`). Seul le français existe aujourd'hui ; aucun texte des
 * rapports n'est écrit ailleurs.
 */
export const REPORT_LABELS_FR = {
  locale: 'fr-FR',
  currency: 'FCFA',
  documentTitle: 'Historique mensuel des ventes',
  common: {
    unavailable: 'Information indisponible',
    none: '—',
    productDeleted: 'Produit supprimé',
    productInTrash: 'Dans la corbeille',
    productAvailable: 'Disponible',
    sellerUnavailable: 'Compte vendeur supprimé',
    page: (page: number, total: number) => `Page ${page} / ${total}`,
    continued: (title: string) => `${title} (suite)`,
  },
  summary: {
    sheet: 'Synthèse',
    title: 'Bilan du mois',
    business: 'Commerce',
    period: 'Période',
    periodStart: 'Début de la période',
    periodEnd: 'Fin de la période',
    timeZone: 'Fuseau horaire',
    generatedAt: 'Rapport généré le',
    generatedBy: 'Généré par',
    currentMonth: 'Mois en cours : situation au moment de la génération.',
    revenue: 'Montant des ventes',
    quantity: 'Quantité vendue',
    salesCount: 'Nombre de ventes',
    productsSold: 'Produits vendus',
    sellers: 'Vendeurs',
    estimatedGain: 'Gain estimé des produits vendus',
    corrections: 'Corrections de ventes',
    cancellations: 'Annulations de ventes',
    noSales: 'Aucune vente enregistrée pour ce mois.',
    notesTitle: 'À savoir',
    notes: {
      pending:
        'Les ventes encore en attente de synchronisation sur un appareil ne figurent pas dans ce rapport : elles y apparaîtront une fois reçues par le serveur.',
      bounds: (timeZone: string) =>
        `Le mois commence le 1er à 00:00 et se termine à la fin du dernier jour, dans le fuseau ${timeZone}. Une vente compte à la date où elle a eu lieu, même si elle a été synchronisée plus tard. Mêmes règles que l'écran Analyse.`,
      current:
        'Les ventes figurent telles qu’elles sont aujourd’hui, corrections comprises ; les ventes annulées n’y figurent plus et sont listées à part.',
      names:
        'Le nom du produit est celui enregistré lors de la vente. Quand le produit a été renommé ou supprimé depuis, son nom actuel ou son dernier nom connu est indiqué à côté.',
      gain: "Gain estimé : montant des ventes moins le prix d'achat, pour les seules ventes du mois. Même valeur que la carte « Gain estimé du mois » de l'écran Analyse : prix d'achat actuel du produit, ou prix figé lors de sa suppression ; les coûts des autres mois ne comptent pas. Si le prix d'achat d'un produit supprimé n'a pas été conservé, son gain reste indisponible.",
      gainUnknown:
        "Le gain total est indisponible : le prix d'achat d'au moins un produit supprimé n'a pas été conservé.",
      movements:
        "Corrections et annulations : seules celles enregistrées dans l'historique du commerce pendant ce mois sont listées. Les ajouts de stock ne sont pas repris : leur historique ne confirme pas l'opération.",
    },
  },
  sales: {
    sheet: 'Ventes',
    title: 'Ventes du mois',
    date: 'Date de la vente',
    product: 'Produit (nom lors de la vente)',
    currentName: 'Nom actuel ou dernier connu',
    productState: 'État du produit',
    quantity: 'Quantité',
    unitPrice: 'Prix unitaire',
    amount: 'Montant',
    seller: 'Vendeur',
    buyer: 'Acheteur',
    buyerContact: 'Contact de l’acheteur',
    total: 'Total du mois',
    nameNotRecorded: 'Nom non enregistré lors de la vente',
    empty: 'Aucune vente enregistrée pour ce mois.',
  },
  products: {
    sheet: 'Par produit',
    title: 'Récapitulatif par produit',
    product: 'Produit',
    state: 'État du produit',
    quantity: 'Quantité vendue',
    salesCount: 'Nombre de ventes',
    revenue: 'Montant des ventes',
    gain: 'Gain estimé',
    empty: 'Aucun produit vendu ce mois-ci.',
  },
  sellers: {
    sheet: 'Par vendeur',
    title: 'Récapitulatif par vendeur',
    seller: 'Vendeur',
    quantity: 'Quantité vendue',
    salesCount: 'Nombre de ventes',
    revenue: 'Montant des ventes',
    empty: 'Aucune vente enregistrée pour ce mois.',
  },
  movements: {
    sheet: 'Corrections et annulations',
    title: 'Corrections et annulations',
    date: "Date de l'opération",
    kind: 'Opération',
    correction: 'Correction',
    cancellation: 'Annulation',
    product: 'Produit (nom actuel ou dernier connu)',
    saleDate: 'Date de la vente concernée',
    quantityBefore: 'Quantité avant',
    quantityAfter: 'Quantité après',
    priceBefore: 'Prix unitaire avant',
    priceAfter: 'Prix unitaire après',
    detail: 'Détail',
    actor: 'Effectuée par',
    unchanged: 'inchangé',
    detailQuantity: (from: string, to: string) => `Quantité : ${from} → ${to}`,
    detailPrice: (from: string, to: string) => `Prix : ${from} → ${to}`,
    detailCancelled: (quantity: string, price: string) =>
      `Vente annulée : ${quantity} × ${price}`,
    empty: 'Aucune correction ni annulation enregistrée pendant ce mois.',
  },
} as const;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : { [K in keyof T]: Widen<T[K]> };

export type ReportLabels = Widen<typeof REPORT_LABELS_FR>;

export const REPORT_LABELS: Record<'fr', ReportLabels> = {
  fr: REPORT_LABELS_FR,
};
