// 1-16G — Gabarit des documents, titres des documents, acceptation.
// Le CONTENU des documents est dans `i18n/documents/<page>/<langue>.tsx`.
const legalFr = {
  document: {
    skipToContent: "Aller au contenu",
    version: "Version {{version}}, mise à jour le {{date}}.",
    toc: "Sommaire",
    question:
      "Une question sur ce texte ? <contact>Contacter Stock Master</contact>",
  },
  documents: {
    "mentions-legales": {
      title: "Mentions légales",
      short: "Mentions légales",
      inSentence: "mentions légales",
    },
    "conditions-utilisation": {
      title: "Conditions d'utilisation",
      short: "Conditions d'utilisation",
      inSentence: "conditions d'utilisation",
    },
    "conditions-abonnement": {
      title: "Conditions d'abonnement",
      short: "Conditions d'abonnement",
      inSentence: "conditions d'abonnement",
    },
    confidentialite: {
      title: "Politique de confidentialité",
      short: "Confidentialité",
      inSentence: "politique de confidentialité",
    },
    cookies: {
      title: "Cookies et stockage sur l'appareil",
      short: "Cookies et stockage",
      inSentence: "cookies et stockage sur l'appareil",
    },
    "traitement-donnees": {
      title: "Accord de traitement des données",
      short: "Traitement des données",
      inSentence: "accord de traitement des données",
    },
  },
  acceptance: {
    prefix: "J'ai lu et j'accepte",
    article: "les",
    and: " et ",
    comma: ", ",
    newTab: "(nouvel onglet)",
    versions_one: "(version {{versions}})",
    versions_many: "(versions {{versions}})",
    versions_other: "(versions {{versions}})",
    notice:
      "Pour savoir quelles données sont traitées et pourquoi, consulte la <doc></doc> (version {{version}}). Elle t'informe : la lire ne vaut pas accord.",
    errors: {
      required:
        "Coche la case pour accepter les conditions avant de continuer.",
      outdated:
        "Les conditions ont été mises à jour. Recharge la page pour lire la nouvelle version, puis recommence.",
      mismatch:
        "Les conditions affichées ne correspondent pas aux textes en vigueur. Recharge la page, puis recommence.",
      archive:
        "L'enregistrement de ton acceptation est momentanément indisponible. Réessaie dans quelques instants.",
    },
  },
  prompt: {
    title: "Ton accord est demandé",
    description:
      "Avant de continuer à utiliser Stock Master, lis les textes ci-dessous. Ton accord n'est enregistré que si tu coches la case et valides.",
    outdated:
      "De nouvelles versions des conditions sont en vigueur. Recharge la page pour les afficher avant de donner ton accord.",
    notice:
      "Information : <doc></doc> (version {{version}}). La lire ne vaut pas accord.",
    offline: "Connexion Internet nécessaire pour enregistrer ton accord.",
    recorded: "Ton accord est enregistré.",
    later: "Plus tard",
    saving: "Enregistrement…",
    accept: "J'accepte",
    reload: "Recharger",
  },
  authLinks: {
    label: "Aide et informations",
    guide: "Guide",
    contact: "Contact",
    terms: "Conditions d'utilisation",
    subscriptionTerms: "Conditions d'abonnement",
    privacy: "Confidentialité",
  },
} as const;

export default legalFr;
