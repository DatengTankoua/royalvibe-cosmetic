// 1-16G — Organisation : onglets, marque, membres, invitations, droits,
// hors connexion, assistance. Codes internes (rôles, permissions, statuts)
// jamais traduits : seules leurs étiquettes le sont.
const organizationFr = {
  title: "Organisation",
  loading: "Chargement…",
  saving: "Enregistrement…",
  creating: "Création…",
  deleting: "Suppression…",
  actions: {
    save: "Enregistrer",
    cancel: "Annuler",
    close: "Fermer",
  },
  tabs: {
    branding: "Branding",
    members: "Membres",
    invitations: "Invitations",
    subscription: "Abonnement",
    offline: "Hors connexion",
    notifications: "Notifications",
    support: "Assistance",
    storage: "Stockage",
  },
  roles: {
    owner: "Propriétaire",
    admin: "Administrateur",
    seller: "Vendeur",
  },
  permissions: {
    "catalog.manage": "Gérer le catalogue",
    "products.manage": "Gérer les produits",
    "stock.adjust": "Ajuster le stock",
    "sales.record": "Enregistrer des ventes",
    "sales.view_own": "Voir ses propres ventes",
    "sales.view_all": "Voir toutes les ventes",
    "products.view_stock_details": "Voir le détail du stock",
    "products.view_financials": "Voir les coûts et résultats financiers",
    "analytics.read": "Voir les analyses",
    "audit.read": "Voir l'historique d'audit",
    "trash.manage": "Gérer la corbeille",
    "branding.manage": "Gérer le branding",
    "members.invite": "Inviter des membres",
    "members.manage": "Gérer les membres",
    "support.contact": "Contacter le service client",
    "sales.notifications": "Recevoir les notifications de ventes",
  },
  memberStatus: {
    active: "Active",
    suspended: "Suspendue",
    revoked: "Révoquée",
  },
  invitationStatus: {
    pending: "En attente",
    accepted: "Acceptée",
    revoked: "Révoquée",
    expired: "Expirée",
  },
  permissionsField: {
    label: "Permissions supplémentaires",
    none: "Aucune permission supplémentaire disponible.",
    adminAll: "Un administrateur dispose de toutes les permissions.",
  },
  errors: {
    SELF_MANAGEMENT_FORBIDDEN:
      "Un membre ne peut pas modifier sa propre membership.",
    OWNER_NOT_MANAGEABLE:
      "Le propriétaire ne peut pas être modifié depuis cet écran.",
    EMPTY_MEMBERSHIP_UPDATE: "Au moins un champ doit être modifié.",
    TRANSFER_TARGET_IS_CURRENT_OWNER:
      "Cette personne est déjà propriétaire de l'organisation.",
    TRANSFER_TARGET_NOT_ACTIVE:
      "La cible du transfert doit avoir une membership active.",
    MEMBER_ALREADY_ACTIVE:
      "Cet email appartient déjà à un membre actif de cette organisation.",
    INVITATION_ALREADY_PENDING:
      "Une invitation est déjà en attente pour cet email.",
    INVITATION_LINK_UNAVAILABLE:
      "Le lien d'invitation ne peut pas être généré pour le moment. Contacte l'administrateur de l'application.",
    EMPTY_BRANDING_UPDATE: "Au moins un champ (nom, couleur, logo) est requis.",
    PERMISSION_DENIED: "Permission insuffisante pour cette action.",
  },
  branding: {
    updated: "Branding mis à jour",
    logoRemoved: "Logo supprimé",
    // R2 privé : l'ancien fichier n'a pas pu être effacé du stockage.
    oldLogoNotDeleted:
      "L'ancien fichier du logo n'a pas pu être effacé du stockage ; il y reste pour l'instant.",
    logoAlt: "Logo de l'organisation",
    noLogo: "Aucun logo",
    colorLabel: "Couleur {{color}}",
    removeLogo: "Supprimer le logo",
    name: "Nom de l'organisation",
    color: "Couleur de marque",
    logo: "Logo (optionnel)",
    logoTooLarge: "Le logo ne doit pas dépasser 2 Mo.",
    logoHelp: "PNG, WebP non animé ou JPEG, 2 Mo maximum.",
    readOnly: "Voir le branding et la couleur de marque de l'organisation.",
  },
  members: {
    transferred: "Propriété transférée",
    permissionRequired:
      "La permission « {{permission}} » est requise pour accéder à cet écran.",
    you: "(vous)",
    edit: "Modifier",
    editTitle: "Modifier {{name}}",
    transfer: "Transférer la propriété",
    transferTitle: "Transférer la propriété ?",
    transferText:
      "Tu vas céder définitivement la propriété de cette organisation à <name></name>. Tu deviendras administrateur et ne pourras plus annuler cette action toi-même.",
    transferring: "Transfert…",
    transferConfirm: "Confirmer le transfert",
    updated: "Membre mis à jour",
    status: "Statut",
  },
  invitations: {
    revoked: "Invitation révoquée",
    empty: "Aucune invitation pour le moment.",
    expiresOn: "Expire le {{date}}",
    expiresAt: "Expire le {{date}}.",
    revoke: "Révoquer",
    revokeTitle: "Révoquer cette invitation ?",
    revokeText:
      "L'invitation destinée à <email></email> ne pourra plus être acceptée.",
    revoking: "Révocation…",
    created: "Invitation créée",
    invite: "Inviter un membre",
    newTitle: "Nouvelle invitation",
    copyHint:
      "Copie ce lien et transmets-le à {{email}}. Il n'est affiché qu'une seule fois.",
    link: "Lien d'invitation",
    copy: "Copier le lien",
    copied: "Lien copié",
    copyManual:
      "Copie automatique impossible : le lien est sélectionné, copie-le manuellement.",
    email: "Email",
    role: "Rôle",
    submit: "Créer l'invitation",
  },
  // 1-17B — espace de stockage de l'organisation (photos et logo).
  storage: {
    title: "Espace de stockage",
    text: "Photos des produits (corbeille comprise) et logo de l'organisation. La limite est fixée par Stock Master.",
    used: "{{used}} utilisés sur {{limit}}",
    available: "Disponible : {{available}}",
    files_one: "{{count}} fichier enregistré",
    files_many: "{{count}} fichiers enregistrés",
    files_other: "{{count}} fichiers enregistrés",
    pending_one:
      "{{count}} envoi en cours ou interrompu ({{size}} réservés). L'espace réservé est libéré automatiquement s'il n'est pas utilisé.",
    pending_many:
      "{{count}} envois en cours ou interrompus ({{size}} réservés). L'espace réservé est libéré automatiquement s'il n'est pas utilisé.",
    pending_other:
      "{{count}} envois en cours ou interrompus ({{size}} réservés). L'espace réservé est libéré automatiquement s'il n'est pas utilisé.",
    full: "Espace plein : les nouveaux envois de photos et de logo sont bloqués. Les ventes et les autres fonctions restent disponibles. Videz la corbeille ou remplacez des photos pour libérer de l'espace.",
    nearlyFull: "Espace presque plein.",
    trashNote:
      "Placer un produit dans la corbeille ne libère pas d'espace ; la suppression définitive, oui.",
    notEnforced: "Limite non appliquée pour le moment (comptage seulement).",
    refresh: "Actualiser",
    unavailable: "Occupation indisponible pour le moment.",
    offline: "Connexion nécessaire pour afficher l'occupation.",
  },
  offlineData: {
    cleared: "Données hors connexion supprimées.",
    clearFailed: "Impossible de supprimer les données hors connexion.",
    title: "Données hors connexion",
    text: "Stock Master conserve une copie en lecture seule du dernier catalogue chargé avec succès (sections, produits, stock, prix), ainsi que le nom et la couleur du commerce, pour les afficher sans connexion, pendant 72 heures maximum. Aucune vente, image, donnée d'audit ou d'une autre organisation n'y est jamais stockée.",
    clear: "Supprimer les données hors connexion",
  },
  support: {
    title: "Contacter le service client",
    intro:
      "Décrivez votre question ou votre problème. La réponse arrivera par e-mail.",
    forbidden:
      "Votre rôle ne permet pas de contacter le service client depuis ce commerce. Demandez ce droit au propriétaire ou à un administrateur, ou utilisez les coordonnées de la page <contact>Contact</contact>.",
    sentTitle: "Message transmis",
    referenceLabel: "Référence de votre demande :",
    sentText:
      "Le service d'envoi a accepté votre message. Cela ne confirme pas encore sa lecture : la réponse arrivera à {{email}}. Citez la référence si vous écrivez à nouveau.",
    yourEmail: "votre adresse e-mail",
    writeAnother: "Écrire un autre message",
    offline:
      "Pas de connexion : l'envoi nécessite Internet. Vous pouvez continuer à écrire, votre texte reste sur cet écran.",
    category: "Catégorie",
    choose: "Choisir…",
    categories: {
      usage: "Utilisation",
      subscription: "Abonnement",
      technical: "Problème technique",
      other: "Autre",
    },
    subject: "Sujet",
    message: "Message",
    charCount: "{{length}} / {{count}} caractères",
    fieldErrors: {
      category: "Choisissez une catégorie.",
      subject: "Indiquez un sujet.",
      message: "Écrivez votre message.",
    },
    contextTitle: "Informations transmises au service client",
    contextText:
      "Elles sont jointes automatiquement à votre message pour retrouver votre compte et votre commerce. Elles ne sont pas modifiables ici. Aucune vente, aucun contact d'acheteur, aucun fichier ni mot de passe n'est joint.",
    name: "Nom",
    replyEmail: "E-mail (réponse)",
    shop: "Commerce",
    page: "Page concernée",
    reference: "Référence :",
    sending: "Envoi…",
    submit: "Envoyer au service client",
    errors: {
      offline:
        "Pas de connexion : l'envoi nécessite Internet. Votre message est conservé sur cet écran.",
      uncertain:
        "Nous ne savons pas si le message est parti. Réessayez : pendant 24 heures, un nouvel essai ne crée pas de doublon.",
      expired:
        "Nous ne savons pas si ce message est parti, et il ne peut plus être renvoyé sans risque de doublon. Écrivez à {{email}} en citant la référence.",
      "in-progress":
        "L'envoi de ce message est déjà en cours. Patientez quelques secondes puis réessayez.",
      unavailable:
        "Le message n'a pas pu être transmis pour le moment. Réessayez plus tard : votre texte est conservé.",
      "rate-limited":
        "Trop de demandes envoyées. Réessayez dans quelques minutes : votre texte est conservé.",
      forbidden:
        "Vous n'avez plus le droit de contacter le service client depuis ce commerce.",
      invalid: "Vérifiez la catégorie, le sujet et le message.",
      conflict:
        "Ce message a changé depuis le premier essai. Il sera envoyé comme une nouvelle demande.",
    },
  },
} as const;

export default organizationFr;
