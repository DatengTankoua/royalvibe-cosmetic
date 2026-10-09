import { randomUUID } from 'crypto';
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

// 1-18C : vérification anti-robot de l'inscription en mode SIMULÉ
// (aucun réseau ; refusé hors `NODE_ENV=test` ou origines en boucle
// locale). Les suites qui testent Turnstile lui-même règlent leur propre
// configuration.
process.env.TURNSTILE_SIMULATED ??= 'true';

/** Jeton simulé neuf (usage unique, comme un jeton Cloudflare). */
export function simulatedTurnstileToken(action = 'register'): string {
  return `simulated-pass:${action}:${randomUUID()}`;
}

/**
 * À étaler dans le corps de `POST /auth/register`. `turnstileToken` est un
 * accesseur énumérable : chaque étalement (`...OWNER_TERMS`) produit un
 * jeton neuf.
 */
export const OWNER_TERMS: {
  readonly legalAcceptance: ReturnType<typeof legalAcceptanceFor>;
  readonly turnstileToken: string;
} = Object.freeze(
  Object.defineProperty(
    {
      legalAcceptance: legalAcceptanceFor(
        LegalAcceptanceContext.OWNER_REGISTRATION,
      ),
    },
    'turnstileToken',
    { enumerable: true, get: () => simulatedTurnstileToken() },
  ) as {
    legalAcceptance: ReturnType<typeof legalAcceptanceFor>;
    turnstileToken: string;
  },
);

/** À étaler dans le corps de `POST /auth/invitations/accept` (compte créé). */
export const INVITATION_TERMS = Object.freeze({
  legalAcceptance: legalAcceptanceFor(
    LegalAcceptanceContext.INVITATION_ACCOUNT,
  ),
});
