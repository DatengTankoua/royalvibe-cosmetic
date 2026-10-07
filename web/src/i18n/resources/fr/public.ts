// 1-16G — Pages publiques : accueil, en-têtes, pied de page.
const publicFr = {
  skipToContent: "Aller au contenu",
  nav: {
    features: "Fonctionnalités",
    offline: "Sans réseau",
    pricing: "Tarifs",
    faq: "Questions",
  },
  header: {
    homeTop: "Stock Master, haut de page",
    backHome: "Stock Master, retour à l'accueil",
    sections: "Sections de la page",
    sectionsMenu: "Sections de la page (menu)",
    openMenu: "Ouvrir le menu",
    closeMenu: "Fermer le menu",
    help: "Aide",
    guide: "Guide",
    contact: "Contact",
  },
  footer: {
    tagline: "Stock, ventes et équipe pour les commerces, depuis le téléphone.",
    help: "Aide et compte",
    legal: "Informations légales",
    login: "Connexion",
    register: "Inscription",
    pages: {
      guide: "Guide d'utilisation",
      contact: "Contact",
    },
  },
  cta: {
    loading: "Chargement…",
    openApp: "Ouvrir l'application",
    login: "Se connecter",
    register: "Créer un compte",
  },
  preview: {
    analyticsAlt:
      "Écran Analyse de Stock Master pour une boutique fictive : capital investi 324 500 FCFA, chiffre d'affaires 88 250 FCFA, bénéfice net 18 200 FCFA, marge moyenne 20,6 %, 76 unités vendues en 10 transactions.",
    salesAlt:
      "Écran Ventes de Stock Master : liste des ventes enregistrées avec le produit, la quantité, le prix, le total et le vendeur, données fictives.",
    caption:
      "Captures réelles de l'application, avec une boutique et des ventes fictives.",
  },
  landing: {
    meta: {
      title: "Stock Master — Stock et ventes de votre commerce, sur téléphone",
      description:
        "Suivez votre stock, enregistrez vos ventes, travaillez avec vos vendeurs et comprenez votre activité.",
      price: "{{monthly}} par mois, ou {{best}} pour {{term}}",
      trial: "Essai gratuit de {{days}} jours, puis {{price}}.",
      subscription: "Abonnement de {{price}}.",
      ogDescription:
        "Stock, ventes, équipe et analyses pour les commerces et PME.",
      ogTrial: "Essai gratuit de {{days}} jours.",
    },
    hero: {
      title: "Suivez votre stock et vos ventes depuis votre téléphone",
      text: "Stock Master remplace le cahier de la boutique. Ajoutez vos produits, enregistrez chaque vente et voyez ce qui reste en rayon et ce que vous gagnez, seul ou avec vos vendeurs.",
      trialNote:
        "{{days}} jours d'essai gratuit, aucun paiement requis. Ensuite, à partir de <price>{{price}} par mois</price> avec la formule {{term}}.",
      registrationClosed:
        "Les inscriptions sont momentanément fermées. Les commerces déjà inscrits peuvent se connecter.",
      alreadyRegistered: "Déjà inscrit ? <login>Se connecter</login>",
    },
    cta: {
      startTrial: "Commencer mon essai gratuit",
      login: "Se connecter",
      seePricing: "Voir les tarifs",
    },
    benefits: {
      title: "Tout ce qu'il faut pour tenir la boutique",
      stock: {
        title: "Suivre votre stock",
        text: "Rangez vos produits par rayon. Chaque vente fait baisser le stock restant, et l'application vous signale les produits en stock faible ou épuisés.",
      },
      sales: {
        title: "Enregistrer vos ventes",
        text: "Choisissez le produit, la quantité et le prix, puis validez. Chaque vente garde sa date et le nom du vendeur.",
      },
      team: {
        title: "Travailler avec votre équipe",
        text: "Invitez vos vendeurs avec un lien et choisissez ce que chacun peut faire : vendre, gérer le catalogue, voir les chiffres. Le prix ne change pas avec le nombre de vendeurs.",
      },
      analytics: {
        title: "Comprendre votre activité",
        text: "La page Analyse calcule votre chiffre d'affaires, votre bénéfice et votre marge, et classe vos produits et vos vendeurs.",
      },
      alsoIncluded:
        "Aussi inclus : la corbeille pour récupérer un produit supprimé, le convertisseur euro ↔ franc CFA, le logo et la couleur de votre commerce, et un centre de notifications dans l'application.",
    },
    offline: {
      title: "Le réseau coupe ? Vous continuez à vendre.",
      steps: {
        open: {
          title: "Ouvrez l'application avec du réseau",
          text: "Le téléphone garde votre catalogue et votre droit de vendre pendant 72 heures.",
        },
        sell: {
          title: "Vendez même sans connexion",
          text: "Chaque vente est enregistrée sur l'appareil et marquée « en attente ».",
        },
        sync: {
          title: "Le réseau revient, les ventes partent",
          text: "L'envoi est automatique. Le serveur vérifie le stock ; si une vente pose problème, elle vous est signalée pour que vous décidiez.",
        },
      },
      note: "Sans réseau, seule la vente est possible. Ajouter des produits, consulter les analyses ou gérer l'équipe demande une connexion. Les ventes en attente restent sur l'appareil jusqu'à 14 jours.",
    },
    pricing: {
      title: "Un abonnement, la durée de votre choix",
      text: "Toutes les fonctionnalités, pour tout le commerce. Le montant indiqué est le total payé pour la durée choisie.",
      trial: "{{days}} jours d'essai gratuit, sans carte bancaire",
      equivalent:
        "Soit {{monthly}} par mois et {{saving}} d'économie par rapport au paiement mensuel.",
      equivalentFree:
        "Soit {{monthly}} par mois et {{saving}} d'économie par rapport au paiement mensuel, soit {{highlight}}.",
      monthByMonth: "Paiement mois par mois.",
      closed:
        "Les inscriptions sont momentanément fermées. <login>Se connecter</login>",
    },
    faq: {
      title: "Questions fréquentes",
      startOpen: {
        question: "Comment je commence ?",
        answer:
          "Créez votre compte avec le nom de votre commerce, puis confirmez votre adresse e-mail grâce au lien reçu. Connectez-vous, ajoutez vos rayons et vos produits : vous pouvez enregistrer vos premières ventes. L'essai gratuit de {{days}} jours commence à la création du commerce.",
      },
      startClosed: {
        question: "Comment je commence ?",
        answer:
          "Les inscriptions en ligne sont momentanément fermées. Si votre commerce a déjà un compte, connectez-vous. Un vendeur rejoint le commerce avec le lien d'invitation que lui transmet le propriétaire.",
      },
      sellers: {
        question: "Mes vendeurs peuvent-ils utiliser l'application ?",
        answer:
          "Oui. Depuis l'espace Organisation, créez une invitation : vous obtenez un lien à transmettre au vendeur, par SMS ou messagerie par exemple. Il crée son accès avec ce lien. Chaque membre peut enregistrer des ventes ; vous ajoutez les autres droits un par un.",
      },
      install: {
        question: "Faut-il installer une application sur le téléphone ?",
        answer:
          "Non. Stock Master s'ouvre dans le navigateur d'un téléphone, d'une tablette ou d'un ordinateur, sans passer par un magasin d'applications. Vous avez la possibilité de télécharger l'application depuis le navigateur pour un accès plus rapide. Une fois téléchargée, vous pouvez l'ouvrir directement depuis votre écran d'accueil.",
      },
      network: {
        question: "Et si la connexion est mauvaise ?",
        answer:
          "Si vous avez ouvert l'application avec du réseau dans les 72 dernières heures, vous pouvez continuer à enregistrer des ventes sans connexion. Elles restent sur l'appareil jusqu'à 14 jours et partent dès que le réseau revient. Ajouter des produits, consulter les analyses ou gérer l'équipe demande une connexion.",
      },
      subscription: {
        question: "Comment fonctionne l'abonnement ?",
        answer:
          "Le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
        answerTrial:
          "Après les {{days}} jours d'essai, le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
      },
      privacy: {
        question: "Les autres commerces voient-ils mes données ?",
        answer:
          "Non. Chaque commerce a son propre espace. Seuls les membres que vous invitez y accèdent, avec les droits que vous leur donnez.",
      },
    },
    final: {
      titleOpen: "Essayez Stock Master dans votre boutique",
      titleClosed: "Retrouvez votre boutique dans Stock Master",
      textOpen:
        "Créez votre compte, ajoutez quelques produits et enregistrez vos premières ventes. Vous avez {{days}} jours gratuits pour vous faire un avis.",
      textClosed:
        "Connectez-vous pour retrouver votre catalogue, vos ventes et vos analyses.",
    },
  },
} as const;

export default publicFr;
