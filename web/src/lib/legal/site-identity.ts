// 1-16C / 1-16C.1 — Source UNIQUE de l'identité éditoriale, des
// coordonnées et de l'état des documents publics. Toute page juridique ou
// d'aide lit ces valeurs : aucune coordonnée ne doit être recopiée ailleurs.
//
// 1-16C.1 : coordonnées CONFIRMÉES par le propriétaire le 7 octobre 2026.
// Une information non encore fournie n'est ni affichée ni inventée : elle
// figure en commentaire ci-dessous, prête à être ajoutée. Les pages restent
// déployables en l'état ; leur statut « projet » (registre plus bas) est
// conservé tant que les validations juridiques manquent.

export const SITE = Object.freeze({
  name: "Stock Master",
  domain: "stock-master.app",
  url: "https://stock-master.app",
  country: "Cameroun",
});

/**
 * Exploitant, tel que déclaré par le propriétaire. Aucune forme juridique,
 * aucun capital ni aucun numéro n'est déduit du nom.
 */
export const OPERATOR = Object.freeze({
  /** Nom légal déclaré. */
  legalName: "Stock Master",
  /** Nom commercial. */
  tradeName: "Stock Master",
  /** Nature de l'exploitant, telle que déclarée (« entreprise »). */
  kind: "entreprise",
  // À AJOUTER quand communiqués (ne rien déduire) :
  // phone: "…",                 // téléphone (annoncé ultérieurement)
  // rccm: "…",                  // RCCM, s'il s'applique (annoncé ultérieurement)
  // taxpayerNumber: "…",        // NIU, s'il s'applique (annoncé ultérieurement)
  // legalForm: "…",             // forme juridique (non communiquée)
  // shareCapital: "…",          // capital, pour une société (non communiqué)
  // publicationDirector: "…",   // directeur de la publication (non communiqué)
});

/**
 * Implantations déclarées. Aucune n'est désignée comme siège social : cette
 * information n'a pas été communiquée.
 */
export const LOCATIONS: readonly string[] = Object.freeze([
  "Bijou Maképé, Douala, Cameroun",
  "Carrefour GP Melen, après l'ancien commissariat du 13e, Yaoundé, Cameroun",
]);

export const CONTACT_EMAILS = Object.freeze({
  contact: "contact@stock-master.app",
  support: "support@stock-master.app",
  privacy: "confidentialite@stock-master.app",
  noreply: "noreply@stock-master.app",
});

/**
 * État des adresses : DÉCLARÉES fonctionnelles par le propriétaire le
 * 7 octobre 2026. Aucun envoi ni aucune réception n'a été testé par
 * l'équipe technique (validations 1-16C.1 : transport e-mail simulé).
 */
export const CONTACT_EMAILS_STATUS = Object.freeze({
  declaredWorkingByOwner: "2026-10-07",
  testedByTechnicalTeam: false,
});

/**
 * Prestataires techniques tels que DOCUMENTÉS dans le dépôt (rapports
 * 1-14D.2E.1, 1-12E ; « observé » ou « selon D9 »). La configuration de
 * production, les régions et les contrats n'ont PAS été vérifiés : `country`
 * reste `null` tant qu'ils ne sont pas confirmés.
 */
export const PROVIDERS: ReadonlyArray<{
  role: string;
  name: string;
  country: string | null;
  status: string;
}> = Object.freeze([
  {
    role: "Hébergement de l'application web",
    name: "Vercel",
    country: null,
    status: "documenté, à confirmer",
  },
  {
    role: "Hébergement de l'API (serveur)",
    name: "Railway",
    country: null,
    status: "documenté, à confirmer",
  },
  {
    role: "Base de données",
    name: "MongoDB Atlas",
    country: null,
    status: "documenté, à confirmer",
  },
  {
    role: "Stockage des images (logos, photos de produits)",
    name: "Supabase Storage",
    country: null,
    status: "documenté, à confirmer",
  },
  {
    role: "Envoi des e-mails (confirmation, réinitialisation)",
    name: "Resend",
    country: null,
    status: "fournisseur intégré ; activation en production à confirmer",
  },
]);

export type DocumentStatus = "projet" | "en-vigueur";

export interface PublicDocument {
  href: string;
  title: string;
  /** Libellé court pour les listes de liens. */
  short: string;
  status: DocumentStatus;
  /** Version affichée ; « projet » tant que non validée. */
  version: string;
  updatedAt: string;
}

// Statut « projet » conservé (non indexé) tant que les validations
// juridiques manquent ; la version affichée reste 0.x.
const DRAFT = {
  status: "projet",
  version: "0.2",
  updatedAt: "7 octobre 2026",
} as const;

/** Documents juridiques et contractuels, dans l'ordre d'affichage. */
export const LEGAL_DOCUMENTS: readonly PublicDocument[] = Object.freeze([
  {
    href: "/mentions-legales",
    title: "Mentions légales",
    short: "Mentions légales",
    ...DRAFT,
  },
  {
    href: "/conditions-utilisation",
    title: "Conditions d'utilisation",
    short: "Conditions d'utilisation",
    ...DRAFT,
  },
  {
    href: "/conditions-abonnement",
    title: "Conditions d'abonnement",
    short: "Conditions d'abonnement",
    ...DRAFT,
  },
  {
    href: "/confidentialite",
    title: "Politique de confidentialité",
    short: "Confidentialité",
    ...DRAFT,
  },
  {
    href: "/cookies",
    title: "Cookies et stockage sur l'appareil",
    short: "Cookies et stockage",
    ...DRAFT,
  },
  {
    href: "/traitement-donnees",
    title: "Accord de traitement des données",
    short: "Traitement des données",
    ...DRAFT,
  },
]);

export const HELP_PAGES = Object.freeze([
  { href: "/guide", short: "Guide d'utilisation" },
  { href: "/contact", short: "Contact" },
] as const);

export function legalDocument(href: string): PublicDocument {
  const doc = LEGAL_DOCUMENTS.find((d) => d.href === href);
  if (!doc) throw new Error(`Document inconnu : ${href}`);
  return doc;
}
