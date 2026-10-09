// 1-16G — Textes partagés : langue, thème, shell /app, actions, erreurs
// génériques, hors connexion.
const commonFr = {
  meta: {
    appDescription: "Application de gestion des stocks et des ventes",
  },
  language: {
    title: "Langue",
    trigger: "Langue : {{language}}",
  },
  theme: {
    title: "Thème d'affichage",
    trigger: "Thème d'affichage : {{theme}}",
    light: "Clair",
    dark: "Sombre",
    system: "Automatique",
  },
  backToHome: "Retour à l'accueil",
  notFound: {
    code: "Erreur 404",
    title: "Cette page est introuvable",
    text: "Le lien est peut-être incomplet ou la page a été déplacée.",
  },
  offline: {
    title: "Vous êtes hors connexion",
    text: "Les données de gestion (catalogue, ventes, analyses) et toute modification nécessitent une connexion Internet. Reconnecte-toi puis réessaie.",
  },
  actions: {
    retry: "Réessayer",
    cancel: "Annuler",
    close: "Fermer",
    save: "Enregistrer",
    delete: "Supprimer",
    back: "Retour",
  },
  fields: {
    maxLength_one: "{{count}} caractère maximum.",
    maxLength_many: "{{count}} caractères maximum.",
    maxLength_other: "{{count}} caractères maximum.",
  },
  errors: {
    network: "Impossible de joindre le serveur. Vérifiez votre connexion.",
    subscriptionInactive: "L'abonnement de ce commerce n'est pas actif.",
    statusUnavailable: "Vérification momentanément indisponible. Réessayez.",
    forbidden: "Accès refusé.",
    notFound: "Ressource introuvable.",
    server: "Erreur serveur. Réessayez dans quelques instants.",
    status: "Erreur {{status}}.",
    unexpected: "Une erreur inattendue s'est produite.",
    uploadInterrupted: "L'envoi du fichier a été interrompu. Réessayez.",
  },
  converter: {
    title: "Convertisseur EUR ↔ Franc CFA",
    euro: "Euro (€)",
    cfa: "Franc CFA (FCFA)",
    rate: "Taux fixe officiel : 1 EUR = {{rate}} FCFA",
    parity: "(Parité fixe FCFA zone UEMOA / Banque de France)",
  },
  shell: {
    nav: {
      home: "Accueil",
      catalog: "Catalogue",
      sales: "Ventes",
      analytics: "Analyse",
      trash: "Corbeille",
      organization: "Organisation",
      help: "Aide",
    },
    myShop: "Mon commerce",
    myAccount: "Mon compte",
    loading: "Chargement…",
    offline: "Hors connexion",
    offlineUnavailable: "Indisponible hors connexion",
    otherPagesOffline: "Autres pages : indisponible hors connexion",
    offlineMessage:
      "Vous êtes hors connexion. Vous pouvez consulter les données enregistrées sur cet appareil et saisir des ventes qui seront envoyées au retour de la connexion.",
    organizationUnavailable: "Organisation actuelle indisponible.",
    converter: "Convertisseur EUR ↔ CFA",
    more: "Plus",
    quit: "Quitter",
    accessRefused:
      "Ton accès à cette organisation n'est plus actif. Contacte un administrateur ou déconnecte-toi.",
    noOrganization:
      "Aucune organisation active. Contacte un administrateur ou déconnecte-toi.",
    logout: {
      button: "Se déconnecter",
      unverified:
        "Ventes locales non vérifiées : elles restent conservées sur cet appareil.",
      synced: "Ventes synchronisées.",
      stillPending:
        "Certaines ventes restent en attente (autre organisation, conflit ou réseau).",
    },
  },
} as const;

export default commonFr;
