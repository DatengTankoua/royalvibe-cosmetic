import { apiClient } from "../api";
import { legalDocumentById, type PublicDocument } from "./site-identity";

// 1-16C.2 — Acceptation versionnée des conditions. Miroir de
// `api/src/legal/legal-documents.ts` : le navigateur indique seulement CE
// QU'IL A AFFICHÉ (identifiants, versions, langue). Le serveur vérifie que
// ce sont les versions en vigueur, fixe lui-même la date, les versions et
// les empreintes enregistrées : rien de ce qui part d'ici n'est une preuve.

/**
 * Langue des textes présentés. Seul le français est publié ; une version
 * anglaise s'ajoutera ici quand elle existera ET sera archivée côté API
 * (le serveur refuse une langue sans texte archivé).
 */
export const LEGAL_LOCALE = "fr";

export type LegalAcceptanceContext =
  "owner_registration" | "invitation_account";

/**
 * Documents à ACCEPTER (case) et documents seulement PRÉSENTÉS (information,
 * sans accord) par parcours. Les conditions d'abonnement concernent
 * uniquement la personne qui crée le commerce.
 */
const REQUIREMENTS: Record<
  LegalAcceptanceContext,
  { documents: readonly string[]; notices: readonly string[] }
> = {
  owner_registration: {
    documents: ["conditions-utilisation", "conditions-abonnement"],
    notices: ["confidentialite"],
  },
  invitation_account: {
    documents: ["conditions-utilisation"],
    notices: ["confidentialite"],
  },
};

export interface LegalDocumentRef {
  id: string;
  version: string;
}

export interface LegalAcceptancePayload {
  accepted: true;
  locale: string;
  documents: LegalDocumentRef[];
  notices: LegalDocumentRef[];
}

function displayed(id: string): PublicDocument {
  const doc = legalDocumentById(id);
  if (!doc) throw new Error(`Document juridique inconnu : ${id}`);
  return doc;
}

function refs(ids: readonly string[]): LegalDocumentRef[] {
  return ids.map((id) => ({ id, version: displayed(id).version }));
}

/** Documents affichés pour un parcours (liens de la case). */
export function legalDocumentsFor(context: LegalAcceptanceContext): {
  documents: PublicDocument[];
  notices: PublicDocument[];
} {
  const r = REQUIREMENTS[context];
  return {
    documents: r.documents.map(displayed),
    notices: r.notices.map(displayed),
  };
}

/** Charge utile envoyée UNIQUEMENT quand la case a été cochée. */
export function buildLegalAcceptance(
  context: LegalAcceptanceContext,
): LegalAcceptancePayload {
  const r = REQUIREMENTS[context];
  return {
    accepted: true,
    locale: LEGAL_LOCALE,
    documents: refs(r.documents),
    notices: refs(r.notices),
  };
}

export const LEGAL_ACCEPTANCE_REQUIRED = "LEGAL_ACCEPTANCE_REQUIRED";
export const LEGAL_VERSION_OUTDATED = "LEGAL_VERSION_OUTDATED";
export const LEGAL_LOCALE_UNAVAILABLE = "LEGAL_LOCALE_UNAVAILABLE";
export const LEGAL_DOCUMENTS_INVALID = "LEGAL_DOCUMENTS_INVALID";
export const LEGAL_ARCHIVE_UNAVAILABLE = "LEGAL_ARCHIVE_UNAVAILABLE";

/** Message lisible pour un refus lié à l'acceptation ; `null` sinon. */
export function legalAcceptanceErrorMessage(code: unknown): string | null {
  switch (code) {
    case LEGAL_ACCEPTANCE_REQUIRED:
      return "Coche la case pour accepter les conditions avant de continuer.";
    case LEGAL_VERSION_OUTDATED:
      return "Les conditions ont été mises à jour. Recharge la page pour lire la nouvelle version, puis recommence.";
    case LEGAL_LOCALE_UNAVAILABLE:
    case LEGAL_DOCUMENTS_INVALID:
      return "Les conditions affichées ne correspondent pas aux textes en vigueur. Recharge la page, puis recommence.";
    case LEGAL_ARCHIVE_UNAVAILABLE:
      return "L'enregistrement de ton acceptation est momentanément indisponible. Réessaie dans quelques instants.";
    default:
      return null;
  }
}

// ─── Comptes existants (confirmation dans l'application) ───────────────────

export interface LegalAcceptanceStatus {
  /** Invite activée côté serveur (`LEGAL_ACCEPTANCE_PROMPT_ENABLED`). */
  promptEnabled: boolean;
  locale: string;
  /** Documents en vigueur pas encore acceptés par ce compte (ce commerce). */
  pending: LegalDocumentRef[];
  notices: LegalDocumentRef[];
}

export async function fetchLegalAcceptanceStatus(): Promise<LegalAcceptanceStatus> {
  const { data } =
    await apiClient.get<LegalAcceptanceStatus>("/legal/acceptance");
  return data;
}

/**
 * Les versions affichées par ce navigateur correspondent-elles à celles que
 * le serveur demande ? Sinon, la page doit être rechargée avant tout accord.
 */
export function matchesDisplayedVersions(
  status: LegalAcceptanceStatus,
): boolean {
  return [...status.pending, ...status.notices].every(
    (ref) => legalDocumentById(ref.id)?.version === ref.version,
  );
}

export async function confirmLegalAcceptance(
  status: LegalAcceptanceStatus,
): Promise<{ status: "recorded" | "already-accepted" }> {
  const payload: LegalAcceptancePayload = {
    accepted: true,
    locale: LEGAL_LOCALE,
    documents: status.pending.map((r) => ({
      id: r.id,
      version: displayed(r.id).version,
    })),
    notices: status.notices.map((r) => ({
      id: r.id,
      version: displayed(r.id).version,
    })),
  };
  const { data } = await apiClient.post("/legal/acceptance", payload);
  return data;
}
