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
  /** Identifiant stable, partagé avec l'API (archive des versions). */
  id: string;
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

// 1-16C.2 — Documents soumis à acceptation (ou présentés à l'inscription) :
// leur texte prérendu est archivé, avec son empreinte, dans
// `api/src/legal/archive/` (manifeste). TOUTE modification du texte affiché
// (y compris d'un prix ou d'une coordonnée rendus dans la page) impose une
// NOUVELLE version ici, puis son archivage : `web/scripts/legal-archive.mjs`
// refuse sinon le build vérifié (texte ≠ archive de la version déclarée).
// Une version archivée n'est jamais réécrite.
const DRAFT_0_3 = {
  status: "projet",
  version: "0.3",
  updatedAt: "7 octobre 2026",
} as const;

// 1-16C.2 (finalisation) — Conditions d'abonnement 0.4 : le paiement en
// ligne n'est pas activé (`UnavailablePaymentProvider`). La version 0.3,
// archivée et éventuellement acceptée, reste dans l'archive sans changement.
const DRAFT_0_4 = {
  status: "projet",
  version: "0.4",
  updatedAt: "7 octobre 2026",
} as const;

// Cookies et accord de traitement : textes modifiés par 03f5459
// (7 octobre 2026, exports mensuels) sans changement de numéro. Leur état
// actuel reçoit la version 0.3. Non soumis à acceptation dans ce lot.
const DRAFT_COOKIES_DPA = {
  status: "projet",
  version: "0.3",
  updatedAt: "7 octobre 2026",
} as const;

/** Documents juridiques et contractuels, dans l'ordre d'affichage. */
export const LEGAL_DOCUMENTS: readonly PublicDocument[] = Object.freeze([
  {
    id: "mentions-legales",
    href: "/mentions-legales",
    title: "Mentions légales",
    short: "Mentions légales",
    ...DRAFT,
  },
  {
    id: "conditions-utilisation",
    href: "/conditions-utilisation",
    title: "Conditions d'utilisation",
    short: "Conditions d'utilisation",
    ...DRAFT_0_3,
  },
  {
    id: "conditions-abonnement",
    href: "/conditions-abonnement",
    title: "Conditions d'abonnement",
    short: "Conditions d'abonnement",
    ...DRAFT_0_4,
  },
  {
    id: "confidentialite",
    href: "/confidentialite",
    title: "Politique de confidentialité",
    short: "Confidentialité",
    ...DRAFT_0_3,
  },
  {
    id: "cookies",
    href: "/cookies",
    title: "Cookies et stockage sur l'appareil",
    short: "Cookies et stockage",
    ...DRAFT_COOKIES_DPA,
  },
  {
    id: "traitement-donnees",
    href: "/traitement-donnees",
    title: "Accord de traitement des données",
    short: "Traitement des données",
    ...DRAFT_COOKIES_DPA,
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

export function legalDocumentById(id: string): PublicDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.id === id);
}
