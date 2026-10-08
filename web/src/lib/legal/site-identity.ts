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

export type LegalDocumentId =
  | "mentions-legales"
  | "conditions-utilisation"
  | "conditions-abonnement"
  | "confidentialite"
  | "cookies"
  | "traitement-donnees";

// 1-16G : titres et libellés courts dans `legal` (`documents.<id>.*`), dans
// chaque langue ; le registre ne garde que l'identité et la version.
export interface PublicDocument {
  /** Identifiant stable, partagé avec l'API (archive des versions). */
  id: LegalDocumentId;
  href: string;
  status: DocumentStatus;
  /** Version affichée ; « projet » tant que non validée. */
  version: string;
  /** Date de mise à jour affichée, écrite dans chaque langue (1-16G). */
  updatedAt: { fr: string; en: string };
}

const OCTOBER_7_2026 = { fr: "7 octobre 2026", en: "7 October 2026" };
const OCTOBER_8_2026 = { fr: "8 octobre 2026", en: "8 October 2026" };

// Statut « projet » conservé (non indexé) tant que les validations
// juridiques manquent ; la version affichée reste 0.x.
const DRAFT = {
  status: "projet",
  version: "0.2",
  updatedAt: OCTOBER_7_2026,
} as const;

// 1-16C.2 — Documents soumis à acceptation (ou présentés à l'inscription) :
// leur texte prérendu est archivé, avec son empreinte, dans
// `api/src/legal/archive/` (manifeste). TOUTE modification du texte affiché
// (y compris d'un prix ou d'une coordonnée rendus dans la page) impose une
// NOUVELLE version ici, puis son archivage : `web/scripts/legal-archive.mjs`
// refuse sinon le build vérifié (texte ≠ archive de la version déclarée).
// Une version archivée n'est jamais réécrite.
//
// 1-16G : la traduction anglaise d'une version porte le MÊME numéro (même
// texte, autre langue) ; elle est archivée comme `<version>.en.txt`. Une
// version déjà archivée n'est jamais traduite après coup (ex. CGA 0.3).
const DRAFT_0_3 = {
  status: "projet",
  version: "0.3",
  updatedAt: OCTOBER_7_2026,
} as const;

// 1-16C.2 (finalisation) — Conditions d'abonnement 0.4 : le paiement en
// ligne n'est pas activé (`UnavailablePaymentProvider`). La version 0.3,
// archivée et éventuellement acceptée, reste dans l'archive sans changement.
const DRAFT_0_4 = {
  status: "projet",
  version: "0.4",
  updatedAt: OCTOBER_7_2026,
} as const;

// Cookies et accord de traitement : textes modifiés par 03f5459
// (7 octobre 2026, exports mensuels) sans changement de numéro. Leur état
// actuel reçoit la version 0.3. Non soumis à acceptation dans ce lot.
const DRAFT_COOKIES_DPA = {
  status: "projet",
  version: "0.3",
  updatedAt: OCTOBER_7_2026,
} as const;

// 1-16G — Confidentialité 0.4 : la langue choisie rejoint les données du
// compte (préférence utilisée pour les e-mails et notifications). La 0.3,
// archivée en français, reste inchangée et n'est jamais traduite.
const DRAFT_PRIVACY_0_4 = {
  status: "projet",
  version: "0.4",
  updatedAt: OCTOBER_8_2026,
} as const;

// 1-16G — Cookies 0.4 : ajout du cookie de langue `stockmaster.lang`.
// 1-16H — Cookies 0.5 : clés de session renommées `stockmaster_token` /
// `stockmaster_user` (anciennement `heyama_token` / `heyama_user`). Document
// non archivé (non soumis à acceptation) : seul le numéro change.
const DRAFT_COOKIES_0_5 = {
  status: "projet",
  version: "0.5",
  updatedAt: OCTOBER_8_2026,
} as const;

/** Documents juridiques et contractuels, dans l'ordre d'affichage. */
export const LEGAL_DOCUMENTS: readonly PublicDocument[] = Object.freeze([
  {
    id: "mentions-legales",
    href: "/mentions-legales",
    ...DRAFT,
  },
  {
    id: "conditions-utilisation",
    href: "/conditions-utilisation",
    ...DRAFT_0_3,
  },
  {
    id: "conditions-abonnement",
    href: "/conditions-abonnement",
    ...DRAFT_0_4,
  },
  {
    id: "confidentialite",
    href: "/confidentialite",
    ...DRAFT_PRIVACY_0_4,
  },
  {
    id: "cookies",
    href: "/cookies",
    ...DRAFT_COOKIES_0_5,
  },
  {
    id: "traitement-donnees",
    href: "/traitement-donnees",
    ...DRAFT_COOKIES_DPA,
  },
]);

// 1-16G : libellés dans `public` (`footer.pages.*`).
export const HELP_PAGES = Object.freeze([
  { href: "/guide", key: "guide" },
  { href: "/contact", key: "contact" },
] as const);

export function legalDocument(href: string): PublicDocument {
  const doc = LEGAL_DOCUMENTS.find((d) => d.href === href);
  if (!doc) throw new Error(`Document inconnu : ${href}`);
  return doc;
}

export function legalDocumentById(id: string): PublicDocument | undefined {
  return LEGAL_DOCUMENTS.find((d) => d.id === id);
}
