import {
  LEGAL_DEFAULT_LOCALE,
  LEGAL_REQUIREMENTS,
  LegalAcceptanceContext,
  LegalArchive,
} from '../../src/legal/legal-documents';

/**
 * 1-16C.2 — Acceptation telle que l'envoie le web (case cochée, versions
 * COURANTES du manifeste). Construite depuis l'archive : une nouvelle
 * version ne casse pas les suites qui n'en testent pas le contenu.
 */
export function legalAcceptanceFor(
  context:
    | LegalAcceptanceContext.OWNER_REGISTRATION
    | LegalAcceptanceContext.INVITATION_ACCOUNT,
) {
  const archive = new LegalArchive();
  const refs = (ids: readonly string[]) =>
    ids.map((id) => {
      const version = archive.currentVersion(id);
      if (!version) throw new Error(`Document non archivé : ${id}`);
      return { id, version };
    });
  const r = LEGAL_REQUIREMENTS[context];
  return {
    accepted: true,
    locale: LEGAL_DEFAULT_LOCALE,
    documents: refs(r.documents),
    notices: refs(r.notices),
  };
}

/** À étaler dans le corps de `POST /auth/register`. */
export const OWNER_TERMS = Object.freeze({
  legalAcceptance: legalAcceptanceFor(
    LegalAcceptanceContext.OWNER_REGISTRATION,
  ),
});

/** À étaler dans le corps de `POST /auth/invitations/accept` (compte créé). */
export const INVITATION_TERMS = Object.freeze({
  legalAcceptance: legalAcceptanceFor(
    LegalAcceptanceContext.INVITATION_ACCOUNT,
  ),
});
