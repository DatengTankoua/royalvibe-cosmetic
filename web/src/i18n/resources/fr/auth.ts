// 1-16G — Connexion, inscription, invitation, mot de passe, confirmation
// d'adresse. Le tutoiement et le vouvoiement d'origine sont conservés.
const authFr = {
  loading: "Chargement…",
  fields: {
    email: "Email",
    name: "Nom",
    organizationName: "Nom de l'entreprise",
  },
  password: {
    label: "Mot de passe",
    confirm: "Confirmer le mot de passe",
    hint: "Entre {{min}} et {{max}} caractères.",
    show: "Afficher le mot de passe",
    hide: "Masquer le mot de passe",
    showBoth: "Afficher les mots de passe",
    hideBoth: "Masquer les mots de passe",
    lengthError:
      "Le mot de passe doit contenir entre {{min}} et {{max}} caractères.",
    mismatch: "Les mots de passe ne correspondent pas.",
  },
  login: {
    subtitle: "Connexion à ton espace de gestion",
    chooseOrganization: "Choisis l'organisation à laquelle te connecter",
    back: "Retour",
    limitedExpired: "Votre accès temporaire a expiré. Reconnectez-vous.",
    forgot: "Mot de passe oublié ?",
    submit: "Se connecter",
    submitting: "Connexion…",
    unverifiedTitle: "Adresse email non confirmée",
    unverifiedText:
      "Confirmez votre adresse email pour accéder à votre compte. Ouvrez le lien reçu par email, ou demandez-en un nouveau.",
    noAccount: "Pas encore de compte ?",
    signUp: "S'inscrire",
    errors: {
      generic: "Erreur de connexion",
    },
    // 1-18C : récupération d'accès après trop de tentatives sur ce compte.
    challenge: {
      required:
        "Trop de tentatives pour ce compte. Valide la vérification anti-robot ci-dessous, puis reconnecte-toi.",
      missing: "Valide d'abord la vérification anti-robot.",
    },
  },
  register: {
    closedTitle: "Inscription désactivée",
    closedText:
      "L'inscription en ligne est momentanément indisponible. Si tu as déjà un compte, connecte-toi.",
    // 1-18E : même écran final que l'adresse ait déjà un compte ou non.
    doneTitle: "Vérifie ta messagerie",
    doneText:
      "Si l'adresse {{email}} peut être utilisée pour un nouveau compte, un email de confirmation vient d'y être envoyé : ouvre le lien qu'il contient.",
    doneExisting:
      "Tu as déjà un compte avec cette adresse ? Connecte-toi, ou réinitialise ton mot de passe si tu l'as oublié.",
    doneForgot: "Réinitialiser mon mot de passe",
    doneResend:
      "Rien reçu après quelques minutes ? Demande un nouveau lien de confirmation :",
    disabled: "L'inscription est actuellement désactivée.",
    title: "Créer ton entreprise",
    subtitle: "Ceci crée ton entreprise et ton compte propriétaire.",
    submit: "Créer mon entreprise",
    submitting: "Création…",
    haveAccount: "Déjà un compte ?",
    // 1-18C : vérification anti-robot (Cloudflare Turnstile).
    antiBot: {
      loading: "Chargement de la vérification anti-robot…",
      notConfigured:
        "La vérification anti-robot n'est pas disponible : cette action est momentanément impossible.",
      loadError:
        "La vérification anti-robot n'a pas pu se charger. Vérifie ta connexion, puis réessaie.",
      failed:
        "La vérification anti-robot a échoué ou a expiré. Recommence-la, puis réessaie.",
      required:
        "Valide la vérification anti-robot avant de créer ton entreprise.",
      unavailable:
        "La vérification anti-robot est momentanément indisponible. Réessaie dans un instant.",
      retry: "Recommencer la vérification",
      simulated: "Je ne suis pas un robot (simulation locale)",
    },
  },
  verify: {
    metaTitle: "Confirmer mon adresse email",
    confirmToAccess:
      "Confirmez votre adresse email pour accéder à votre compte.",
    linkSent: "Un lien de confirmation a été envoyé à {{email}}.",
    missingToken:
      "Lien de confirmation incomplet. Ouvre à nouveau le lien reçu par email, en entier.",
    invalid:
      "Ce lien de confirmation est invalide ou a expiré. Connecte-toi pour demander un nouveau lien.",
    network:
      "Impossible de joindre le serveur. Vérifie ta connexion puis réessaie.",
    failed: "La confirmation n'a pas pu aboutir. Réessaie plus tard.",
    title: "Confirmation de l'adresse email",
    text: "Clique sur le bouton pour confirmer ton adresse email.",
    submitting: "Confirmation…",
    successTitle: "Adresse email confirmée",
    successText: "Tu peux maintenant te connecter.",
  },
  resend: {
    neutral:
      "Si un compte non vérifié correspond à cette adresse, un nouveau lien de confirmation vient d'être envoyé.",
    sending: "Envoi…",
    cooldown: "Renvoyer l'email ({{seconds}} s)",
    button: "Renvoyer l'email de confirmation",
    errors: {
      network: "Impossible de joindre le serveur. Vérifiez votre connexion.",
      rateLimited: "Trop de demandes. Réessayez plus tard.",
      deliveryUnavailable:
        "L'envoi d'emails est momentanément indisponible. Réessayez plus tard.",
      generic: "La demande n'a pas pu aboutir. Réessayez plus tard.",
      // 1-18D : vérification anti-robot avant chaque demande de lien.
      antiBotRequired: "Validez d'abord la vérification anti-robot.",
      antiBotFailed:
        "La vérification anti-robot a échoué ou a expiré. Recommencez-la, puis réessayez.",
      antiBotUnavailable:
        "La vérification anti-robot est momentanément indisponible. Réessayez dans un instant.",
    },
  },
  forgot: {
    title: "Mot de passe oublié",
    text: "Indiquez votre adresse email : nous vous enverrons un lien pour choisir un nouveau mot de passe.",
    neutral:
      "Si un compte correspond à cette adresse, vous recevrez un lien pour réinitialiser votre mot de passe.",
    emailRequired: "Saisissez votre adresse email.",
    cooldown: "Envoyer le lien ({{seconds}} s)",
    submit: "Envoyer le lien",
    backToLogin: "Retour à la connexion",
    errors: {
      network:
        "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez.",
      generic: "Vérifiez l'adresse email saisie puis réessayez.",
    },
  },
  reset: {
    title: "Nouveau mot de passe",
    text: "Choisissez votre nouveau mot de passe.",
    missingToken:
      "Lien de réinitialisation incomplet. Ouvrez à nouveau le lien reçu par email, en entier.",
    invalid:
      "Ce lien de réinitialisation est invalide ou a expiré. Demandez un nouveau lien.",
    network:
      "Impossible de joindre le serveur. Réessayez. Si la modification a pu être enregistrée, une tentative de connexion avec votre nouveau mot de passe permet de le vérifier.",
    submit: "Enregistrer le mot de passe",
    submitting: "Enregistrement…",
    success:
      "Votre mot de passe a été modifié. Connectez-vous avec votre nouveau mot de passe.",
    newLink: "Demander un nouveau lien",
  },
  invitation: {
    missingToken:
      "Lien d'invitation incomplet. Ouvre à nouveau le lien reçu, en entier.",
    checking: "Vérification de l'invitation…",
    // 1-18B : session du compte invité ou lien envoyé à l'adresse invitée.
    chooseTitle: "Invitation à rejoindre un commerce",
    chooseText:
      "Pour accepter, connecte-toi avec le compte de l'adresse invitée. Si tu n'as pas encore de compte, reçois à cette adresse un lien pour le créer.",
    loginToAccept: "Se connecter pour accepter",
    noAccount: "Je n'ai pas de compte",
    sendingLink: "Envoi…",
    cancel: "Annuler",
    linkSentTitle: "Vérifie ta boîte mail",
    linkSent:
      "Si l'adresse invitée n'a pas encore de compte, un lien pour le créer vient d'y être envoyé. Il est valable 24 heures au plus.",
    linkSentExisting:
      "Si tu as déjà un compte avec cette adresse, connecte-toi pour accepter l'invitation.",
    linkErrors: {
      rateLimited: "Trop de demandes. Réessaie plus tard.",
      deliveryUnavailable:
        "L'envoi d'emails est momentanément indisponible. Réessaie plus tard.",
      network: "Connexion impossible. Vérifie ta connexion puis réessaie.",
      generic: "La demande n'a pas pu être envoyée. Réessaie plus tard.",
    },
    confirmTitle: "Rejoindre {{organization}}",
    confirmRole: "Rôle proposé : {{role}}",
    roles: {
      admin: "Administrateur",
      seller: "Vendeur",
    },
    signedInAs: "Connecté en tant que {{email}}",
    accept: "Accepter l'invitation",
    accepting: "Acceptation…",
    decline: "Pas maintenant",
    acceptError: "L'invitation n'a pas pu être acceptée. Réessaie.",
    mismatchTitle: "Ce n'est pas le bon compte",
    mismatchText:
      "Cette invitation est destinée à une autre adresse que celle de ton compte actuel. Connecte-toi avec le compte de l'adresse invitée.",
    switchAccount: "Changer de compte",
    sessionExpired:
      "Ta session a expiré. Reconnecte-toi pour accepter l'invitation.",
    alreadyMember: "Ton compte appartient déjà à ce commerce.",
    openApp: "Ouvrir l'application",
    acceptedTitle: "Invitation acceptée",
    joined: "Tu as rejoint {{organization}}.",
    joinedSwitch: "Pour y accéder, reconnecte-toi et choisis ce commerce.",
    reconnect: "Se reconnecter",
    cancelledTitle: "Invitation non acceptée",
    cancelledText:
      "Rien n'a été modifié. Tu peux rouvrir le lien d'invitation tant qu'il est valable.",
    backHome: "Retour à l'accueil",
    noOrganizationNotice:
      "Ton compte n'appartient encore à aucun commerce actif. Accepte l'invitation pour rejoindre ce commerce ; tu seras ensuite connecté.",
    accountLabel: "Compte : {{email}}",
    loginNotice:
      "Connecte-toi avec le compte de l'adresse invitée pour accepter l'invitation.",
    create: {
      title: "Créer ton compte",
      text: "Choisis ton nom et ton mot de passe pour rejoindre le commerce qui t'a invité.",
      submit: "Créer mon compte et rejoindre",
      submitting: "Création…",
      successTitle: "Compte créé",
      success: "Tu as rejoint {{organization}}. Connecte-toi pour continuer.",
      invalid:
        "Ce lien de création est invalide ou a expiré. Rouvre le lien d'invitation et demande un nouveau lien.",
      exists:
        "Un compte existe déjà pour cette adresse. Connecte-toi, puis rouvre le lien d'invitation.",
      missingToken:
        "Lien de création incomplet. Ouvre à nouveau le lien reçu par email, en entier.",
    },
  },
} as const;

export default authFr;
