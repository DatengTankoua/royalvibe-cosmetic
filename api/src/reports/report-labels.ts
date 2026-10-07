import type { AppLocale } from '../common/i18n/locale';

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

/**
 * 1-16G — libellés anglais : mêmes ventes, mêmes chiffres, mêmes noms
 * d'origine ; seuls les libellés et la présentation des nombres changent
 * (devise FCFA, fuseau et bornes du mois identiques).
 */
export const REPORT_LABELS_EN: ReportLabels = {
  locale: 'en-GB',
  currency: 'FCFA',
  documentTitle: 'Monthly sales history',
  common: {
    unavailable: 'Information unavailable',
    none: '—',
    productDeleted: 'Product deleted',
    productInTrash: 'In the trash',
    productAvailable: 'Available',
    sellerUnavailable: 'Seller account deleted',
    page: (page: number, total: number) => `Page ${page} / ${total}`,
    continued: (title: string) => `${title} (continued)`,
  },
  summary: {
    sheet: 'Summary',
    title: 'Month summary',
    business: 'Shop',
    period: 'Period',
    periodStart: 'Start of the period',
    periodEnd: 'End of the period',
    timeZone: 'Time zone',
    generatedAt: 'Report generated on',
    generatedBy: 'Generated by',
    currentMonth: 'Month in progress: situation at the time of generation.',
    revenue: 'Sales amount',
    quantity: 'Quantity sold',
    salesCount: 'Number of sales',
    productsSold: 'Products sold',
    sellers: 'Sellers',
    estimatedGain: 'Estimated gain on products sold',
    corrections: 'Sale corrections',
    cancellations: 'Sale cancellations',
    noSales: 'No sales recorded for this month.',
    notesTitle: 'Good to know',
    notes: {
      pending:
        'Sales still waiting to be synchronised on a device are not included in this report: they will appear once received by the server.',
      bounds: (timeZone: string) =>
        `The month starts on the 1st at 00:00 and ends at the end of the last day, in the ${timeZone} time zone. A sale counts on the date it took place, even if it was synchronised later. Same rules as the Analytics screen.`,
      current:
        'Sales are shown as they are today, corrections included; cancelled sales no longer appear and are listed separately.',
      names:
        'The product name is the one recorded at the time of the sale. When the product has since been renamed or deleted, its current name or last known name is shown alongside.',
      gain: 'Estimated gain: sales amount minus the purchase price, for the sales of the month only. Same value as the “Estimated gain for the month” card on the Analytics screen: current purchase price of the product, or price kept when it was deleted; costs from other months do not count. If the purchase price of a deleted product was not kept, its gain stays unavailable.',
      gainUnknown:
        'The total gain is unavailable: the purchase price of at least one deleted product was not kept.',
      movements:
        "Corrections and cancellations: only those recorded in the shop's history during this month are listed. Stock additions are not included: their history does not confirm the operation.",
    },
  },
  sales: {
    sheet: 'Sales',
    title: 'Sales of the month',
    date: 'Sale date',
    product: 'Product (name at the time of sale)',
    currentName: 'Current or last known name',
    productState: 'Product status',
    quantity: 'Quantity',
    unitPrice: 'Unit price',
    amount: 'Amount',
    seller: 'Seller',
    buyer: 'Buyer',
    buyerContact: 'Buyer contact',
    total: 'Month total',
    nameNotRecorded: 'Name not recorded at the time of sale',
    empty: 'No sales recorded for this month.',
  },
  products: {
    sheet: 'By product',
    title: 'Summary by product',
    product: 'Product',
    state: 'Product status',
    quantity: 'Quantity sold',
    salesCount: 'Number of sales',
    revenue: 'Sales amount',
    gain: 'Estimated gain',
    empty: 'No products sold this month.',
  },
  sellers: {
    sheet: 'By seller',
    title: 'Summary by seller',
    seller: 'Seller',
    quantity: 'Quantity sold',
    salesCount: 'Number of sales',
    revenue: 'Sales amount',
    empty: 'No sales recorded for this month.',
  },
  movements: {
    sheet: 'Corrections & cancellations',
    title: 'Corrections and cancellations',
    date: 'Operation date',
    kind: 'Operation',
    correction: 'Correction',
    cancellation: 'Cancellation',
    product: 'Product (current or last known name)',
    saleDate: 'Date of the sale concerned',
    quantityBefore: 'Quantity before',
    quantityAfter: 'Quantity after',
    priceBefore: 'Unit price before',
    priceAfter: 'Unit price after',
    detail: 'Detail',
    actor: 'Done by',
    unchanged: 'unchanged',
    detailQuantity: (from: string, to: string) => `Quantity: ${from} → ${to}`,
    detailPrice: (from: string, to: string) => `Price: ${from} → ${to}`,
    detailCancelled: (quantity: string, price: string) =>
      `Sale cancelled: ${quantity} × ${price}`,
    empty: 'No corrections or cancellations recorded during this month.',
  },
};

export const REPORT_LABELS: Record<AppLocale, ReportLabels> = {
  fr: REPORT_LABELS_FR,
  en: REPORT_LABELS_EN,
};
