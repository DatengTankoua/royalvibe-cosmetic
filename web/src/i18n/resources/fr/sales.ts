// 1-16G — Ventes : saisie, correction, liste, ventes en attente (outbox).
const salesFr = {
  loading: "Chargement…",
  seller: "Vendeur :",
  buyer: "Acheteur :",
  syncNow: "Synchroniser maintenant",
  pendingOnDevice: "Ventes en attente sur cet appareil",
  pendingOnDeviceCount: "Ventes en attente sur cet appareil ({{count}})",
  actions: {
    cancel: "Annuler",
    back: "Retour",
    delete: "Supprimer",
    save: "Enregistrer",
    retry: "Réessayer",
  },
  nav: {
    pendingCount_one: "{{count}} vente en attente",
    pendingCount_many: "{{count}} ventes en attente",
    pendingCount_other: "{{count}} ventes en attente",
    pendingShort: "en attente",
    pendingBadge: "Ventes en attente :",
  },
  list: {
    allTitle: "Toutes les ventes",
    ownTitle: "Mes ventes",
    recordOnly:
      "Tu peux enregistrer des ventes depuis la fiche d'un produit. Tu n'as pas la permission de consulter la liste des ventes.",
    noPermission: "Tu n'as pas la permission de consulter les ventes.",
    empty: "Aucune vente enregistrée.",
    nameNotKept: "(nom non conservé)",
    productDeleted: "Produit supprimé",
    nameNotRecorded: "nom non enregistré lors de la vente",
    renamedTo: "Désormais : {{name}}",
  },
  pendingPage: {
    back: "Ventes",
    title: "Ventes en attente",
    text: "Ventes enregistrées sur cet appareil et pas encore confirmées par le serveur. Aucune n'est supprimée sans ton accord.",
  },
  form: {
    title: "Vente",
    titleFix: "Corriger la vente",
    offline:
      "La vente sera enregistrée sur cet appareil et envoyée au retour de la connexion.",
    quantity: "Quantité",
    stock: "Stock : {{count}}",
    indicativeStock: "Stock indicatif : {{count}}",
    actualPrice: "Prix de vente réel (FCFA)",
    total: "Total : {{amount}}",
    buyerName: "Nom acheteur (optionnel)",
    buyerNamePlaceholder: "Prénom / Nom",
    buyerContact: "Contact acheteur (optionnel)",
    buyerContactPlaceholder: "Téléphone ou email",
    indicativeNote:
      "Des ventes de ce produit sont en attente d'envoi : le stock affiché est indicatif.",
    seePending: "Voir les ventes en attente",
    sending: "Envoi…",
    saving: "Enregistrement…",
    saveFix: "Enregistrer la correction",
    confirm: "Confirmer la vente",
    record: "Enregistrer une vente",
    recorded: "Vente enregistrée",
    conflictHint: "Voir « Ventes en attente » pour la corriger.",
    pending:
      "Vente enregistrée sur cet appareil, en attente de synchronisation",
    pendingHint: "Elle sera envoyée automatiquement au retour de la connexion.",
    errors: {
      quantity: "La quantité doit être un entier supérieur ou égal à 1.",
      aboveIndicative: "Quantité supérieure au stock indicatif ({{max}}).",
      aboveStock: "Quantité supérieure au stock disponible ({{max}}).",
      price: "Le prix doit être un nombre positif ou nul.",
      buyerLength: "Nom et contact : {{max}} caractères maximum.",
    },
    refusal: {
      capability: "Saisie de vente non autorisée sur cet appareil.",
      identity: "Session non vérifiée sur cet appareil : reconnecte-toi.",
      invalid: "Données de vente invalides.",
      limit:
        "Limite de 200 ventes en attente atteinte : synchronise-les avant d'en saisir d'autres.",
      unavailable: "Stockage local indisponible : vente non enregistrée.",
      "not-replaceable": "Cette vente ne peut plus être corrigée.",
    },
  },
  edit: {
    title: "Modifier la vente",
    price: "Prix de vente (FCFA)",
    updated: "Vente mise à jour",
    deleted: "Vente supprimée",
    deleteTitle: "Supprimer cette vente ?",
    deleteText:
      "Le stock sera restauré automatiquement. Cette action est irréversible.",
    deleting: "Suppression…",
  },
  logout: {
    title: "Ventes non synchronisées",
    description_one:
      "{{count}} vente enregistrée sur cet appareil n'a pas encore été confirmée par le serveur.",
    description_many:
      "{{count}} ventes enregistrées sur cet appareil n'ont pas encore été confirmées par le serveur.",
    description_other:
      "{{count}} ventes enregistrées sur cet appareil n'ont pas encore été confirmées par le serveur.",
    descriptionOrganizations_one:
      "{{count}} vente enregistrée sur cet appareil ({{organizations}} organisations) n'a pas encore été confirmée par le serveur.",
    descriptionOrganizations_many:
      "{{count}} ventes enregistrées sur cet appareil ({{organizations}} organisations) n'ont pas encore été confirmées par le serveur.",
    descriptionOrganizations_other:
      "{{count}} ventes enregistrées sur cet appareil ({{organizations}} organisations) n'ont pas encore été confirmées par le serveur.",
    syncing: "Synchronisation… (10 s max)",
    keep: "Se déconnecter et conserver sur cet appareil",
    delete: "Supprimer définitivement…",
    deleteWarning:
      "Ces ventes seront effacées de cet appareil et ne seront JAMAIS envoyées au serveur. Action irréversible.",
    deleteFailed:
      "Suppression impossible : rien n'a été effacé. Réessaie ou conserve les ventes.",
    deleteConfirm: "Supprimer définitivement et se déconnecter",
  },
  outbox: {
    loading: "Chargement des ventes locales…",
    unreadable:
      "Ventes locales illisibles pour cette session. Reconnecte-toi pour y accéder ; elles restent conservées sur cet appareil.",
    counts: {
      pending: "En attente",
      syncing: "Envoi",
      conflict: "À traiter",
    },
    status: {
      pending: "En attente",
      syncing: "Envoi en cours",
      synced: "Synchronisée",
      conflict: "À traiter",
      abandoned: "Abandonnée",
    },
    blocked: {
      subscription:
        "Envoi suspendu : l'abonnement de ce commerce n'est pas actif. Les ventes restent sur cet appareil et repartiront après le renouvellement.",
      accessDenied:
        "Envoi suspendu : le serveur a refusé l'accès (session, droits ou organisation). Reconnecte-toi ou contacte un administrateur ; les ventes restent sur cet appareil.",
      corruption:
        "Envoi suspendu : une incohérence a été détectée. Note les ventes concernées et contacte le support avant de retirer l'opération.",
    },
    resumeOnline:
      "L'envoi reprendra automatiquement au retour de la connexion, application ouverte.",
    empty: "Aucune vente en attente sur cet appareil.",
    listLabel: "Ventes non finalisées",
    actionFailed: "Action impossible.",
    recentlySynced: "Récemment synchronisées ({{count}})",
    syncedRetention: "Effacées automatiquement de cet appareil après 7 jours.",
    cancelledLater: "Annulée ensuite",
    confirmed: "Confirmée",
    attempts_one: "Tentatives : {{count}}.",
    attempts_many: "Tentatives : {{count}}.",
    attempts_other: "Tentatives : {{count}}.",
    confirm: {
      removeTitle: "Retirer cette vente de la file ?",
      abandonTitle: "Abandonner cette vente ?",
      mayBeRecorded:
        "Attention : le serveur a peut-être déjà enregistré cette vente. Vérifie la liste des ventes avant de l'abandonner.",
      neverSent: "Cette vente ne sera jamais envoyée au serveur.",
      staysVisible:
        "Elle ne sera plus proposée à l'envoi et restera visible sur cet appareil (aucune suppression silencieuse).",
    },
    actions: {
      edit: "Corriger",
      retry: "Réessayer",
      abandon: "Abandonner",
      remove: "Retirer",
      removeFromQueue: "Retirer de la file",
    },
    errors: {
      insufficientStock: "Stock insuffisant côté serveur.",
      productNotFound: "Produit introuvable ou supprimé.",
      dateOutOfRange: "Date de vente hors de la période autorisée.",
      validationFailed: "Données de vente refusées par le serveur.",
      expired:
        "Vente en attente depuis plus de 14 jours : non envoyée automatiquement.",
      serverUnavailable: "Serveur indisponible après plusieurs tentatives.",
      alreadyApplied: "Déjà enregistrée par le serveur, puis annulée.",
      inconsistency:
        "Incohérence détectée : notez cette vente et contactez le support.",
      accessDenied: "Accès refusé par le serveur.",
      subscriptionInactive:
        "Abonnement du commerce inactif : vente conservée, envoi après renouvellement.",
      network: "Réseau indisponible, nouvel essai automatique.",
      server: "Envoi momentanément impossible, nouvel essai automatique.",
      auth: "Session expirée ou accès refusé.",
      refused: "Vente refusée par le serveur.",
    },
  },
} as const;

export default salesFr;
