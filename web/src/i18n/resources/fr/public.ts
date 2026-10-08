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
      "Capture de l'écran Analyse de Stock Master pour la boutique fictive Boutique Démo, mois en cours : montant des ventes 137 500 FCFA (+13,8 % par rapport à la même période du mois précédent), 58 ventes pour 84 unités, gain estimé 28 050 FCFA, puis le graphique des ventes par jour.",
    salesAlt:
      "Capture de l'écran Ventes de Stock Master pour la boutique fictive Boutique Démo : dernières ventes enregistrées, avec produit, vendeur, date, quantité et montant en FCFA.",
    caption:
      "Captures réelles de l'application, interface en français · Boutique Démo, produits et ventes fictifs.",
  },
  landing: {
    meta: {
      title: "Stock Master — Stock et ventes de votre commerce, sur téléphone",
      description:
        "Ventes et stock en temps réel, aide au réapprovisionnement et historique mensuel Excel/PDF. En français et en anglais.",
      price: "{{monthly}} par mois, ou {{best}} pour {{term}}",
      trial: "Essai gratuit de {{days}} jours, puis {{price}}.",
      subscription: "Abonnement de {{price}}.",
      ogDescription:
        "Stock, ventes, équipe et analyses pour les commerces et PME.",
      ogTrial: "Essai gratuit de {{days}} jours.",
    },
    hero: {
      title: "Suivez votre stock et vos ventes depuis votre téléphone",
      text: "Une vente de deux savons ? Le stock baisse et vos collègues connectés voient la mise à jour. Stock Master rassemble le catalogue, les ventes et les repères utiles pour tenir votre boutique.",
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
        text: "Rangez le riz, l'huile et les savons par rayon. Chaque vente met à jour le stock ; les produits presque épuisés ou en rupture sont signalés selon vos droits.",
      },
      sales: {
        title: "Enregistrer vos ventes",
        text: "Choisissez le produit, la quantité et le prix réel. La vente garde sa date et le nom du vendeur. Les collègues connectés retrouvent les mises à jour sans recharger la page.",
      },
      team: {
        title: "Travailler avec votre équipe",
        text: "Invitez vos vendeurs avec un lien et choisissez ce que chacun peut faire : vendre, gérer le catalogue, voir les chiffres. Le prix ne change pas avec le nombre de vendeurs.",
      },
      analytics: {
        title: "Comprendre votre activité",
        text: "L'Analyse montre les produits à surveiller, les meilleures ventes et le gain estimé selon vos droits. Par exemple, repérez l'huile à réapprovisionner au rythme des ventes enregistrées : c'est une aide à la décision, pas une commande automatique ni un bénéfice garanti.",
      },
      history: {
        title: "Garder l'historique du mois",
        text: "Propriétaire et administrateur : choisissez un mois dans Analyse et téléchargez l'Excel ou le PDF. Retrouvez le bilan, les ventes, les produits, les vendeurs et les corrections, hors ventes encore en attente sur un appareil.",
      },
      notifications: {
        title: "Retrouver les alertes et l'aide",
        text: "La cloche rassemble les notifications correspondant à vos droits. Besoin d'aide sur une vente ? Le propriétaire, l'administrateur ou un vendeur autorisé peut écrire depuis Organisation → Assistance.",
      },
      alsoIncluded:
        "À votre façon : français ou anglais, mode clair ou sombre, logo et couleurs du commerce. Aussi inclus : corbeille et convertisseur euro ↔ franc CFA.",
    },
    offline: {
      title: "Le réseau coupe ? Vous continuez à vendre.",
      steps: {
        open: {
          title: "Ouvrez l'application avec du réseau",
          text: "Sur le même appareil, compte et commerce, chargez le catalogue avec une session autorisée à vendre. Le catalogue et cette autorisation sont conservés au plus 72 heures ; la session doit rester valide.",
        },
        sell: {
          title: "Vendez même sans connexion",
          text: "Une vente de savon reste sur cet appareil, marquée « en attente ». Le stock hors ligne est indicatif : il ne voit pas les ventes des collègues.",
        },
        sync: {
          title: "Le réseau revient, les ventes partent",
          text: "Avec l'application ouverte et une session valide, l'envoi reprend automatiquement. Le serveur revérifie le stock et les droits ; en cas de refus, consultez Ventes en attente.",
        },
      },
      note: "Sans réseau : catalogue déjà chargé et saisie de nouvelles ventes seulement. Produits, analyses, exports et gestion d'équipe demandent une connexion. La file est limitée à 200 ventes non finalisées par compte et commerce sur cet appareil ; après 14 jours, une vente n'est plus envoyée automatiquement. Gardez le même appareil pour la reprise.",
    },
    pricing: {
      title: "Un abonnement, la durée de votre choix",
      text: "Un tarif pour tout le commerce. Le montant indiqué couvre la durée choisie. Le paiement en ligne n'est pas disponible : pour renouveler, le propriétaire contacte l'assistance.",
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
          "Le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Le paiement en ligne n'est pas encore disponible ; pour renouveler, il contacte l'assistance. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
        answerTrial:
          "Après les {{days}} jours d'essai, le propriétaire choisit une durée de 1, 3, 6 ou 12 mois depuis l'espace Abonnement. Le paiement en ligne n'est pas encore disponible ; pour renouveler, il contacte l'assistance. Il n'y a aucun prélèvement automatique : chaque renouvellement est volontaire. Le prix couvre tout le commerce, quel que soit le nombre de vendeurs.",
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
