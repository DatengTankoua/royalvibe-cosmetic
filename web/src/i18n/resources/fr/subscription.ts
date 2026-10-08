// 1-16G — Abonnement : offres, état, renouvellement, paiement, blocage.
const subscriptionFr = {
  offers: {
    term: {
      monthly: "1 mois",
      quarterly: "3 mois",
      semiannual: "6 mois",
      annual: "12 mois",
    },
    highlight: {
      saving: "{{amount}} d'économie",
      freeMonths: "2 mois offerts",
    },
    best: "Le plus avantageux",
    forTerm: "pour {{term}}",
    monthlyEquivalent: "soit {{amount}} / mois en équivalent mensuel",
    saving: "Économie de {{amount}} par rapport au paiement mensuel",
    monthlyPayment: "Paiement mensuel",
    included: {
      catalog: "Catalogue, stock et ventes",
      converter: "Convertisseur EUR ↔ FCFA",
      analytics: "Analyses et corbeille",
      members: "Membres et permissions",
    },
    ctaLabel: "{{label}} — formule {{term}}",
    selectorLabel: "Durée du renouvellement",
    conditions: {
      features:
        "Mêmes fonctionnalités pour toutes les durées, selon les droits de chaque membre.",
      perShop: "Abonnement par commerce, sans supplément par vendeur.",
      noAutoPay:
        "Aucun prélèvement automatique : chaque renouvellement est volontaire.",
    },
  },
  overview: {
    dateAt: "{{date}} à {{time}}",
    state: {
      trial: "Essai gratuit en cours",
      active: "Abonnement actif",
      expired: "Abonnement expiré",
      scheduled: "Période à venir",
      none: "Aucun abonnement",
    },
    trial: "Essai gratuit",
    subscriptionTerm: "Abonnement {{term}}",
    lessThanDay: "moins d'un jour",
    days_one: "{{count}} jour",
    days_many: "{{count}} jours",
    days_other: "{{count}} jours",
    status: "État",
    currentPeriod: "Période en cours",
    fromTo: "du {{from}} au {{to}}",
    accessEnded: "Accès terminé le",
    accessUntil: "Accès couvert jusqu'au",
    remaining: "Temps restant : {{remaining}}",
    nextPeriod: "Prochaine période",
    startingOn: "à partir du {{date}}",
    historyTitle: "Historique des périodes",
    historyEmpty: "Aucune période.",
    historyNote:
      "Historique des périodes d'accès, sans montant : les paiements figurent dans l'historique des paiements ; les factures seront disponibles ultérieurement.",
  },
  manager: {
    checkUnavailable: "Vérification momentanément indisponible.",
    infoUnavailable: "Informations d'abonnement indisponibles.",
    loading: "Chargement de l'abonnement…",
    verify: "Vérifier mon abonnement",
    renewal: "Renouvellement",
    paymentUnavailable:
      "Paiement momentanément indisponible. Utilisez « Vérifier mon abonnement ».",
  },
  page: {
    title: "Abonnement",
    loading: "Chargement…",
    ownerOnly:
      "La gestion de l'abonnement est réservée au propriétaire du commerce.",
    verified: "Abonnement vérifié.",
  },
  block: {
    title: {
      expired: "L'abonnement de ce commerce a expiré",
      none: "Ce commerce n'a pas d'abonnement actif",
      scheduled: "L'abonnement de ce commerce n'a pas encore commencé",
      active: "L'abonnement de ce commerce est actif",
      inactive: "L'abonnement de ce commerce n'est pas actif",
    },
    text: {
      offline:
        "Vous êtes hors connexion. La vérification reprendra au retour de la connexion.",
      activeLimited:
        "Utilisez « Vérifier mon abonnement » pour retrouver l'accès.",
      owner: "Renouvelez l'abonnement pour retrouver l'accès à votre commerce.",
      member: "Contactez le propriétaire pour renouveler.",
    },
    verifyAccess: "Vérifier l'accès",
    logout: "Se déconnecter",
  },
  verify: {
    stillInactive: "L'abonnement n'est toujours pas actif.",
    stale: "La session a changé : rechargez la page.",
    offline: "Vérification impossible hors connexion.",
  },
  access: {
    yourShop: "Votre commerce",
    retry: "Réessayer",
  },
  localSales: {
    unreadable:
      "Ventes locales illisibles pour cette session : elles restent conservées sur cet appareil.",
    title_one: "Ventes en attente sur cet appareil ({{count}})",
    title_many: "Ventes en attente sur cet appareil ({{count}})",
    title_other: "Ventes en attente sur cet appareil ({{count}})",
    text: "Elles sont conservées et seront envoyées après le renouvellement.",
  },
  payment: {
    status: {
      initiating: {
        label: "Demande en cours",
        lower: "demande en cours",
        detail:
          "La demande de paiement est en cours de transmission à l'opérateur.",
      },
      pending: {
        label: "En attente de paiement",
        lower: "en attente de paiement",
        detail:
          "Validez le paiement sur le téléphone du payeur, puis appuyez sur « Vérifier le paiement ».",
      },
      uncertain: {
        label: "Résultat à vérifier",
        lower: "résultat à vérifier",
        detail:
          "La transmission n'a pas pu être confirmée. Vérifiez ce paiement : aucune nouvelle demande ne sera envoyée.",
      },
      review: {
        label: "Vérification nécessaire",
        lower: "vérification nécessaire",
        detail:
          "Ce paiement doit être vérifié par notre équipe. Aucune nouvelle demande n'est possible en attendant.",
      },
      failed: {
        label: "Échec confirmé",
        lower: "échec confirmé",
        detail: "L'opérateur a confirmé que ce paiement n'a pas abouti.",
      },
      succeeded: {
        label: "Paiement confirmé",
        lower: "paiement confirmé",
        detail: "Le paiement est confirmé et l'abonnement a été prolongé.",
      },
    },
    errors: {
      "no-response":
        "Réponse non reçue. Rien n'est perdu : vérifiez votre connexion puis réessayez.",
      unexpected:
        "Réponse non reçue. Rien n'est perdu : vérifiez votre connexion puis réessayez.",
      unauthorized: "Votre session a expiré. Reconnectez-vous.",
      unauthorizedRestricted:
        "Votre session a expiré. Reconnectez-vous : votre paiement sera retrouvé.",
      forbidden: "Accès refusé pour ce commerce.",
      "already-pending": "Un paiement est déjà en cours pour ce commerce.",
      "operation-conflict":
        "Cette demande a déjà été envoyée avec d'autres informations. Saisissez exactement le même numéro.",
      "invalid-phone":
        "Numéro Mobile Money camerounais invalide (ex. 6XX XX XX XX).",
      "invalid-request": "Demande invalide. Vérifiez les informations saisies.",
      "not-found": "Paiement introuvable pour ce commerce.",
      "rate-limited": "Trop de demandes. Patientez avant de réessayer.",
      "service-unavailable":
        "Le paiement en ligne est indisponible pour le moment. Réessayez plus tard.",
      "status-unavailable":
        "Impossible de vérifier ce paiement pour le moment. Réessayez plus tard.",
      "confirmation-pending":
        "Paiement en cours de confirmation. Vérifiez de nouveau dans un instant.",
    },
    messages: {
      offlineCreate:
        "Hors connexion : la création d'un paiement nécessite Internet.",
      termRequired: "Choisissez une durée.",
      phoneRequired: "Saisissez le numéro Mobile Money du payeur.",
      replayed: "Demande retrouvée : aucun nouveau paiement n'a été demandé.",
      sent: "Demande envoyée. L'abonnement sera actif une fois le paiement confirmé.",
      confirmed: "Paiement confirmé. Rétablissement de l'accès…",
      offlineVerify: "Hors connexion : la vérification nécessite Internet.",
      statusChecked: "Statut vérifié : {{status}}.",
      statusNow: "Ce paiement est désormais : {{status}}.",
    },
    loading: "Chargement des paiements…",
    offline:
      "Hors connexion : la création et la vérification d'un paiement nécessitent Internet.",
    term: "Durée",
    totalAmount: "Montant total",
    payer: "Payeur",
    reference: "Référence",
    requestedOn: "Demandé le",
    confirmedOn: "Confirmé le",
    pinNotice:
      "Le code secret Mobile Money se saisit uniquement sur le téléphone du payeur. Stock Master ne le demande jamais.",
    checking: "Vérification…",
    verify: "Vérifier le paiement",
    openShop: "Accéder à mon commerce",
    newAttempt: "Nouvel essai",
    renew: "Renouveler",
    formTitle: "Payer par Mobile Money",
    lockedIntent:
      "Une demande précédente n'a pas reçu de réponse. Saisissez de nouveau <b>le même numéro</b> pour la retrouver : aucun second paiement ne sera demandé. Durée : <b>{{term}}</b>.",
    phoneLabel: "Numéro Mobile Money du payeur",
    phoneHelp:
      "MTN Mobile Money ou Orange Money (Cameroun). Le payeur validera sur son téléphone ; aucun code secret n'est demandé ici.",
    summary:
      "Montant total : <b>{{amount}}</b> pour <b>{{term}}</b>. L'abonnement sera prolongé une fois le paiement confirmé.",
    summaryEmpty: "Sélectionnez une durée pour voir le montant total.",
    sending: "Envoi…",
    payAmount: "Payer {{amount}}",
    pay: "Payer",
    cancel: "Annuler",
    historyTitle: "Historique des paiements",
    historyUnavailable: "Historique des paiements indisponible.",
    historyMore: "Impossible de charger plus de paiements.",
    historyEmpty: "Aucun paiement.",
    loadingMore: "Chargement…",
    showMore: "Afficher plus",
  },
} as const;

export default subscriptionFr;
