import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join, resolve, sep } from 'path';

/**
 * 1-16C.2 — Documents juridiques versionnés et leur archive.
 *
 * Source de vérité : `archive/manifest.json` et les textes `archive/<id>/
 * <version>.<langue>.txt`, produits par `web/scripts/legal-archive.mjs`
 * depuis le HTML PRÉRENDU des pages (texte réellement présenté). Le
 * manifeste fixe, pour chaque document, la version COURANTE et l'empreinte
 * SHA-256 de chaque texte archivé. Une version archivée n'est jamais
 * réécrite (refus du script, test d'intégrité, `.gitattributes -text`).
 *
 * Le serveur détermine seul les versions, langues et empreintes
 * enregistrées : le navigateur indique ce qu'il a affiché, ce qui permet de
 * refuser une page périmée, mais ne fournit jamais la preuve.
 *
 * Copié dans `dist/legal/archive` par `nest build` (`assets`,
 * `nest-cli.json`) : présent dans l'image de production.
 */
export const LEGAL_ARCHIVE_DIR = join(__dirname, 'archive');

export const TERMS_OF_USE = 'conditions-utilisation';
export const SUBSCRIPTION_TERMS = 'conditions-abonnement';
export const PRIVACY_NOTICE = 'confidentialite';

/**
 * Langue proposée par défaut. 1-16G : l'anglais est publié pour les versions
 * en vigueur (archives `<version>.en.txt`) ; une version archivée en
 * français seulement n'est jamais traduite après coup.
 */
export const LEGAL_DEFAULT_LOCALE = 'fr';

export enum LegalAcceptanceContext {
  /** Inscription : compte + commerce ; conditions d'utilisation ET d'abonnement. */
  OWNER_REGISTRATION = 'owner_registration',
  /** Création d'un compte par invitation : conditions d'utilisation. */
  INVITATION_ACCOUNT = 'invitation_account',
  /** Compte existant, après connexion : documents en attente seulement. */
  ACCOUNT_CONFIRMATION = 'account_confirmation',
}

/**
 * Documents à ACCEPTER et documents seulement PRÉSENTÉS (information sans
 * accord) par parcours. Les conditions d'abonnement engagent uniquement la
 * personne qui crée le commerce (propriétaire).
 */
export const LEGAL_REQUIREMENTS: Readonly<
  Record<
    | LegalAcceptanceContext.OWNER_REGISTRATION
    | LegalAcceptanceContext.INVITATION_ACCOUNT,
    { documents: readonly string[]; notices: readonly string[] }
  >
> = Object.freeze({
  [LegalAcceptanceContext.OWNER_REGISTRATION]: {
    documents: [TERMS_OF_USE, SUBSCRIPTION_TERMS],
    notices: [PRIVACY_NOTICE],
  },
  [LegalAcceptanceContext.INVITATION_ACCOUNT]: {
    documents: [TERMS_OF_USE],
    notices: [PRIVACY_NOTICE],
  },
});

const ID_PATTERN = /^[a-z][a-z-]{0,39}$/;
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}$/;
const LOCALE_PATTERN = /^[a-z]{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface LegalManifestLocale {
  file: string;
  sha256: string;
}

export interface LegalManifestVersion {
  publishedAt: string;
  locales: Record<string, LegalManifestLocale>;
}

export interface LegalManifestDocument {
  route: string;
  current: string;
  versions: Record<string, LegalManifestVersion>;
}

export interface LegalManifest {
  schema: 1;
  documents: Record<string, LegalManifestDocument>;
}

/** Texte archivé, résolu depuis le manifeste (jamais depuis le client). */
export interface ResolvedLegalDocument {
  documentId: string;
  version: string;
  locale: string;
  sha256: string;
  publishedAt: string;
  file: string;
}

export class LegalArchiveError extends Error {}

function fail(message: string): never {
  throw new LegalArchiveError(`Manifeste juridique invalide : ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validation STRICTE de la forme du manifeste (aucune valeur supposée). */
export function parseLegalManifest(raw: unknown): LegalManifest {
  if (!isRecord(raw) || raw.schema !== 1 || !isRecord(raw.documents)) {
    fail('schéma');
  }
  const documents: Record<string, LegalManifestDocument> = {};
  for (const [id, doc] of Object.entries(raw.documents)) {
    if (!ID_PATTERN.test(id) || !isRecord(doc)) fail(`document ${id}`);
    if (typeof doc.route !== 'string' || !isRecord(doc.versions)) {
      fail(`document ${id}`);
    }
    if (typeof doc.current !== 'string' || !(doc.current in doc.versions)) {
      fail(`${id} : version courante absente`);
    }
    const versions: Record<string, LegalManifestVersion> = {};
    for (const [version, entry] of Object.entries(doc.versions)) {
      if (!VERSION_PATTERN.test(version) || !isRecord(entry)) {
        fail(`${id} ${version}`);
      }
      if (
        typeof entry.publishedAt !== 'string' ||
        !DATE_PATTERN.test(entry.publishedAt) ||
        !isRecord(entry.locales)
      ) {
        fail(`${id} ${version}`);
      }
      const locales: Record<string, LegalManifestLocale> = {};
      for (const [locale, file] of Object.entries(entry.locales)) {
        if (
          !LOCALE_PATTERN.test(locale) ||
          !isRecord(file) ||
          file.file !== `${id}/${version}.${locale}.txt` ||
          typeof file.sha256 !== 'string' ||
          !SHA256_PATTERN.test(file.sha256)
        ) {
          fail(`${id} ${version} ${locale}`);
        }
        locales[locale] = { file: file.file, sha256: file.sha256 };
      }
      if (Object.keys(locales).length === 0) fail(`${id} ${version} : vide`);
      versions[version] = { publishedAt: entry.publishedAt, locales };
    }
    documents[id] = { route: doc.route, current: doc.current, versions };
  }
  return { schema: 1, documents };
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Archive en lecture seule. Chargée à la première utilisation (jamais au
 * démarrage : une archive absente bloque l'acceptation, pas l'API ni les
 * ventes). Chaque texte lu est contrôlé contre l'empreinte du manifeste.
 */
export class LegalArchive {
  private manifest: LegalManifest | null = null;
  private readonly texts = new Map<string, string>();

  constructor(private readonly dir: string = LEGAL_ARCHIVE_DIR) {}

  getManifest(): LegalManifest {
    if (!this.manifest) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(this.dir, 'manifest.json'), 'utf8'));
      } catch {
        throw new LegalArchiveError('Manifeste juridique illisible');
      }
      this.manifest = parseLegalManifest(raw);
    }
    return this.manifest;
  }

  /** Version courante d'un document dans une langue ; `null` si absente. */
  current(documentId: string, locale: string): ResolvedLegalDocument | null {
    const doc = this.getManifest().documents[documentId];
    if (!doc) return null;
    const entry = doc.versions[doc.current];
    const file = entry.locales[locale];
    if (!file) return null;
    return {
      documentId,
      version: doc.current,
      locale,
      sha256: file.sha256,
      publishedAt: entry.publishedAt,
      file: file.file,
    };
  }

  currentVersion(documentId: string): string | null {
    return this.getManifest().documents[documentId]?.current ?? null;
  }

  /** Texte exact archivé ; refus si l'empreinte ne correspond plus. */
  text(doc: ResolvedLegalDocument): string {
    const cached = this.texts.get(doc.file);
    if (cached !== undefined) return cached;
    const root = resolve(this.dir);
    const full = resolve(root, doc.file);
    if (!full.startsWith(root + sep)) {
      throw new LegalArchiveError('Chemin d’archive invalide');
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(full);
    } catch {
      throw new LegalArchiveError(`Texte archivé absent : ${doc.file}`);
    }
    if (sha256Hex(bytes) !== doc.sha256) {
      throw new LegalArchiveError(`Texte archivé altéré : ${doc.file}`);
    }
    const text = bytes.toString('utf8');
    this.texts.set(doc.file, text);
    return text;
  }
}
