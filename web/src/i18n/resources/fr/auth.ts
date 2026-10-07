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
  },
  register: {
    closedTitle: "Inscription désactivée",
    closedText:
      "L'inscription en ligne est momentanément indisponible. Si tu as déjà un compte, connecte-toi.",
    doneTitle: "Compte créé",
    doneText: "Ton entreprise et ton compte propriétaire ont été créés.",
    deliveryFailed:
      "L'email de confirmation n'a pas pu être envoyé. Ton compte est bien créé : demande un nouvel envoi ci-dessous.",
    disabled: "L'inscription est actuellement désactivée.",
    title: "Créer ton entreprise",
    subtitle: "Ceci crée ton entreprise et ton compte propriétaire.",
    submit: "Créer mon entreprise",
    submitting: "Création…",
    haveAccount: "Déjà un compte ?",
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
    acceptedTitle: "Invitation acceptée",
    joined: "Tu as rejoint {{organization}}.",
    joinedLogin: "Tu as rejoint {{organization}}. Connecte-toi pour continuer.",
    loginToContinue: "Connecte-toi pour continuer.",
    deliveryFailed:
      "L'email de confirmation n'a pas pu être envoyé. Demande un nouvel envoi ci-dessous.",
    finish: "Finalise la création de ton compte.",
    submit: "Créer mon compte",
    submitting: "Validation…",
  },
} as const;

export default authFr;
