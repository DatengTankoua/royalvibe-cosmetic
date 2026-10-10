// 1-16G — Centre de notifications, réglages push, invitation PWA. Les
// textes génériques des notifications elles-mêmes sont rendus par l'API
// dans la langue de la requête (centre) ou du destinataire (push).
const notificationsFr = {
  title: "Notifications",
  loading: "Chargement…",
  empty: "Aucune notification.",
  unreadMark: "(non lue)",
  showMore: "Afficher plus",
  noneForRole: "Aucune notification n'est proposée pour votre rôle.",
  categories: {
    stockDepleted: {
      label: "Stock épuisé",
      help: "Quand le stock d'un produit passe à zéro.",
    },
    stockLow: {
      label: "Stock presque épuisé",
      help: "Quand 80 % du stock initial d'un produit est consommé.",
    },
    saleCreated: {
      label: "Nouvelle vente",
      help: "À chaque vente enregistrée par un autre membre (push regroupés par minute).",
    },
    subscriptionEnding: {
      label: "Fin d'essai ou d'abonnement",
      help: "Un rappel dans les 24 heures précédant l'échéance.",
    },
    paymentSucceeded: {
      label: "Paiement confirmé",
      help: "Quand un paiement d'abonnement est confirmé.",
    },
    monthlyReport: {
      label: "Bilan mensuel",
      help: "Au début de chaque mois, le bilan du mois écoulé.",
    },
    memberJoined: {
      label: "Nouveau membre",
      help: "Quand une personne invitée rejoint l'entreprise.",
    },
    memberActivity: {
      label: "Actions des collaborateurs",
      help: "Créations, modifications et suppressions faites par les autres membres (regroupées par minute).",
    },
  },
  bell: {
    noneUnread: "Notifications, aucune non lue",
    moreThan99: "Notifications, plus de 99 non lues",
    unread_one: "Notifications, {{count}} non lue",
    unread_many: "Notifications, {{count}} non lues",
    unread_other: "Notifications, {{count}} non lues",
    recent: "Notifications récentes",
    seeAll: "Voir toutes les notifications",
  },
  list: {
    readAll: "Tout marquer comme lu",
    filter: "Filtre",
    all: "Toutes",
    unread: "Non lues",
    unavailable: "Notifications indisponibles pour le moment.",
    emptyUnread: "Aucune notification non lue.",
  },
  detail: {
    missing: "Notification introuvable ou plus disponible.",
    open: "Ouvrir",
    productRemoved: "Ce produit a été supprimé définitivement.",
    product: "Produit",
    inTrash: "(corbeille)",
    remainingStock: "Stock restant",
    saleCancelled: "Cette vente a été annulée depuis.",
    quantity: "Quantité",
    amount: "Montant",
    seller: "Vendeur",
    date: "Date",
    trialEnd: "Fin de l'essai : {{date}}",
    subscriptionEnd: "Fin de l'abonnement : {{date}}",
    paymentConfirmed: "Paiement confirmé.",
    paymentConfirmedOn: "Paiement confirmé le {{date}}.",
    reportUnavailable: "Bilan indisponible.",
    amountHidden:
      "Montant et quantité visibles seulement avec le droit « Voir toutes les ventes ».",
    member: "Membre",
    role: "Rôle",
    memberInactive: "Ce membre ne fait plus partie de l'entreprise.",
    roles: {
      owner: "Propriétaire",
      admin: "Administrateur",
      seller: "Vendeur",
    },
    author: "Auteur",
    unknownAuthor: "Un collaborateur",
    actionsCount_one: "{{count}} action",
    actionsCount_many: "{{count}} actions",
    actionsCount_other: "{{count}} actions",
    targets: "Éléments concernés",
    unnamed: "Élément sans nom",
    removed: "(supprimé)",
    moreTargets_one: "et {{count}} autre",
    moreTargets_many: "et {{count}} autres",
    moreTargets_other: "et {{count}} autres",
  },
  report: {
    summary_one:
      "Bilan de {{month}} (du {{from}} au {{to}}, fuseau {{timeZone}}) — calculé le {{computedAt}}. {{count}} vente.",
    summary_many:
      "Bilan de {{month}} (du {{from}} au {{to}}, fuseau {{timeZone}}) — calculé le {{computedAt}}. {{count}} ventes.",
    summary_other:
      "Bilan de {{month}} (du {{from}} au {{to}}, fuseau {{timeZone}}) — calculé le {{computedAt}}. {{count}} ventes.",
    topProducts: "Produits les plus vendus",
    noSales: "Aucune vente ce mois-ci.",
    unknownProduct: "Produit inconnu",
    deleted: "(supprimé)",
    unitsSold_one: "{{count}} vendu",
    unitsSold_many: "{{count}} vendus",
    unitsSold_other: "{{count}} vendus",
    sellerOfMonth: "Vendeur du mois",
    noSeller: "Aucun vendeur du mois n'est désigné (aucune vente).",
    unsold: "Produits sans vente ({{count}})",
    allSold: "Tous les produits ont été vendus.",
    addedDuringMonth: "ajouté pendant le mois",
    purgedNote:
      "Produits supprimés définitivement sans vente pendant le mois : non listés (aucune trace conservée).",
  },
  center: {
    title: "Dans l'application",
    text: "Notifications visibles sous la cloche, sur tous vos appareils, même sans notifications push.",
    unavailable: "Préférences indisponibles pour le moment.",
    legend: "Catégories affichées",
  },
  push: {
    title: "Notifications push sur cet appareil",
    text: "Recevez sur cet appareil les alertes importantes, même quand l'application est fermée. Les messages restent volontairement généraux (aucun montant ni nom de produit sur l'écran verrouillé) ; touchez la notification pour voir le détail.",
    unavailable: "Réglages des notifications indisponibles pour le moment.",
    enabled: "Notifications activées sur cet appareil.",
    disabled: "Notifications désactivées sur cet appareil.",
    denied: "Notifications refusées par le navigateur.",
    enabling: "Activation…",
    enable: "Activer les notifications",
    disable: "Désactiver les notifications",
    legend: "Me prévenir pour",
    notices: {
      disabled: "Les notifications ne sont pas disponibles sur ce service.",
      unsupported:
        "Ce navigateur ne prend pas en charge les notifications push.",
      iosInstall:
        "Sur iPhone et iPad, les notifications ne sont proposées qu'à l'application ajoutée à l'écran d'accueil.",
      blocked:
        "Les notifications sont bloquées pour ce site. Autorisez-les dans les réglages du navigateur, puis revenez ici.",
    },
    iosTitle: "iPhone et iPad",
    iosHelp:
      "Ouvrez Stock Master dans Safari, touchez Partager puis « Sur l'écran d'accueil ». Lancez ensuite l'application depuis son icône et revenez sur cette page pour activer les notifications (iOS / iPadOS 16.4 ou plus récent).",
  },
  engagement: {
    later: "Plus tard",
    install: {
      title: "Installer Stock Master",
      body: "Ouvrez l'application depuis l'écran d'accueil, comme une application.",
      action: "Installer",
    },
    ios: {
      title: "Ajouter Stock Master à l'écran d'accueil",
      body: "Sur iPhone et iPad, l'application installée peut aussi recevoir des notifications.",
      help: "Dans Safari, touchez Partager puis « Sur l'écran d'accueil ».",
    },
    push: {
      title: "Activer les notifications",
      body: "Soyez prévenu des ruptures de stock, des ventes et des échéances, même application fermée.",
      action: "Activer",
    },
    denied: {
      title: "Notifications bloquées",
      body: "Les notifications sont refusées pour ce site sur cet appareil.",
      help: "Autorisez-les dans les réglages du navigateur (paramètres du site), puis rechargez la page.",
    },
  },
} as const;

export default notificationsFr;
