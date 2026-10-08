import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import type { Connection, Model } from 'mongoose';
import {
  LEGAL_ACCEPTANCE_REQUIRED,
  LEGAL_ARCHIVE_UNAVAILABLE,
  LEGAL_DOCUMENTS_INVALID,
  LEGAL_LOCALE_UNAVAILABLE,
  LEGAL_VERSION_OUTDATED,
  LegalAcceptanceService,
  legalAcceptanceKey,
} from './legal-acceptance.service';
import {
  LEGAL_ARCHIVE_DIR,
  LEGAL_REQUIREMENTS,
  LegalAcceptanceContext,
  LegalArchive,
  LegalArchiveError,
  PRIVACY_NOTICE,
  SUBSCRIPTION_TERMS,
  TERMS_OF_USE,
  parseLegalManifest,
  sha256Hex,
} from './legal-documents';
import type { LegalAcceptanceDto } from './dto/legal-acceptance.dto';
import type {
  LegalAcceptanceDocument,
  LegalDocumentVersionDocument,
} from './schemas/legal-acceptance.schema';

/**
 * 1-16C.2 — Archive et validation des acceptations (sans base : la preuve
 * enregistrée, les rejeux et l'immuabilité en base sont couverts par
 * `test/legal-acceptance.e2e-spec.ts`).
 */

function listTexts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTexts(full));
    else if (entry.name.endsWith('.txt')) out.push(full);
  }
  return out;
}

const manifestRaw = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(LEGAL_ARCHIVE_DIR, 'manifest.json'), 'utf8'));

describe('archive juridique (manifeste et textes)', () => {
  const archive = new LegalArchive();
  const manifest = archive.getManifest();

  it('chaque texte archivé correspond à son empreinte (aucune réécriture)', () => {
    let count = 0;
    for (const [id, doc] of Object.entries(manifest.documents)) {
      for (const [version, entry] of Object.entries(doc.versions)) {
        for (const [locale, file] of Object.entries(entry.locales)) {
          const bytes = readFileSync(join(LEGAL_ARCHIVE_DIR, file.file));
          expect(sha256Hex(bytes)).toBe(file.sha256);
          expect(file.file).toBe(`${id}/${version}.${locale}.txt`);
          // Octets exacts : aucune fin de ligne Windows (`.gitattributes`).
          expect(bytes.includes(13)).toBe(false);
          count += 1;
        }
      }
    }
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it('aucun texte hors manifeste, aucune entrée sans texte', () => {
    const referenced = new Set<string>();
    for (const doc of Object.values(manifest.documents)) {
      for (const entry of Object.values(doc.versions)) {
        for (const file of Object.values(entry.locales)) {
          referenced.add(file.file);
        }
      }
    }
    const onDisk = listTexts(LEGAL_ARCHIVE_DIR).map((f) =>
      relative(LEGAL_ARCHIVE_DIR, f).split('\\').join('/'),
    );
    expect(onDisk.sort()).toEqual([...referenced].sort());
  });

  it('documents exigés présents, en français, version courante archivée', () => {
    for (const id of [TERMS_OF_USE, SUBSCRIPTION_TERMS, PRIVACY_NOTICE]) {
      const doc = archive.current(id, 'fr');
      expect(doc).not.toBeNull();
      expect(archive.text(doc!)).toContain(`Version ${doc!.version}`);
    }
    // Langue sans document archivé : jamais résolue.
    expect(archive.current(TERMS_OF_USE, 'de')).toBeNull();
  });

  it('1-16G : traductions anglaises archivées, même version que le français', () => {
    for (const id of [TERMS_OF_USE, SUBSCRIPTION_TERMS, PRIVACY_NOTICE]) {
      const fr = archive.current(id, 'fr')!;
      const en = archive.current(id, 'en');
      expect(en).not.toBeNull();
      expect(en!.version).toBe(fr.version);
      expect(en!.sha256).not.toBe(fr.sha256);
      expect(archive.text(en!)).toContain(`Version ${en!.version}`);
    }
  });

  it('1-16G : archives françaises antérieures inchangées, jamais traduites après coup', () => {
    const frozen: Record<string, Record<string, string>> = {
      [TERMS_OF_USE]: {
        '0.3':
          '5c2e4c36edc0ecbd545659a0e12fcb50c36b543277819629ad5dc33c63dec2c2',
      },
      [SUBSCRIPTION_TERMS]: {
        '0.3':
          '7efc7db353af8c9b842e798fb810c8b0082f16d9fe2c0bf116e7218c45a50e72',
        '0.4':
          'bade5d4650c93eed40481082ce6780f3b99073cd5bfc31bc141ca862b392e4ee',
      },
      [PRIVACY_NOTICE]: {
        '0.3':
          '941a2c17b62003c13668af353cf262dbc01616aa7a548c590fe5fb7dc841d082',
      },
    };
    for (const [id, versions] of Object.entries(frozen)) {
      for (const [v, sha256] of Object.entries(versions)) {
        expect(manifest.documents[id].versions[v].locales.fr.sha256).toBe(
          sha256,
        );
      }
    }
    // Versions remplacées avant 1-16G : aucune traduction ajoutée.
    expect(
      manifest.documents[SUBSCRIPTION_TERMS].versions['0.3'].locales.en,
    ).toBeUndefined();
    expect(
      manifest.documents[PRIVACY_NOTICE].versions['0.3'].locales.en,
    ).toBeUndefined();
  });

  it('conditions d’abonnement : 0.4 en vigueur, 0.3 conservée telle quelle', () => {
    const doc = manifest.documents[SUBSCRIPTION_TERMS];
    expect(doc.current).toBe('0.4');
    // Empreinte de la 0.3 publiée et archivée avant la correction : figée.
    expect(doc.versions['0.3'].locales.fr.sha256).toBe(
      '7efc7db353af8c9b842e798fb810c8b0082f16d9fe2c0bf116e7218c45a50e72',
    );
    const current = archive.current(SUBSCRIPTION_TERMS, 'fr')!;
    const text = archive.text(current);
    expect(text).toContain(
      "Le paiement en ligne n'est pas encore activé. Pour toute demande de renouvellement, contactez support@stock-master.app.",
    );
    expect(text).not.toMatch(/paiement en ligne est disponible/i);
    expect(text).not.toMatch(/Mobile Money/);
    const old = archive.text({
      ...current,
      version: '0.3',
      sha256: doc.versions['0.3'].locales.fr.sha256,
      file: doc.versions['0.3'].locales.fr.file,
    });
    expect(old).toContain('Le paiement en ligne est disponible.');
  });

  it('parcours : les conditions d’abonnement ne concernent que le propriétaire', () => {
    expect(
      LEGAL_REQUIREMENTS[LegalAcceptanceContext.OWNER_REGISTRATION],
    ).toEqual({
      documents: [TERMS_OF_USE, SUBSCRIPTION_TERMS],
      notices: [PRIVACY_NOTICE],
    });
    expect(
      LEGAL_REQUIREMENTS[LegalAcceptanceContext.INVITATION_ACCOUNT],
    ).toEqual({ documents: [TERMS_OF_USE], notices: [PRIVACY_NOTICE] });
  });

  it('manifeste refusé : version courante absente, empreinte ou chemin invalides', () => {
    const base = manifestRaw();
    const clone = () => JSON.parse(JSON.stringify(base));
    const noCurrent = clone();
    noCurrent.documents[TERMS_OF_USE].current = '9.9';
    expect(() => parseLegalManifest(noCurrent)).toThrow(LegalArchiveError);
    const badSha = clone();
    const v = badSha.documents[TERMS_OF_USE].current as string;
    badSha.documents[TERMS_OF_USE].versions[v].locales.fr.sha256 = 'abc';
    expect(() => parseLegalManifest(badSha)).toThrow(LegalArchiveError);
    const escape = clone();
    escape.documents[TERMS_OF_USE].versions[v].locales.fr.file =
      '../../../etc/passwd';
    expect(() => parseLegalManifest(escape)).toThrow(LegalArchiveError);
    expect(() => parseLegalManifest({ schema: 2, documents: {} })).toThrow(
      LegalArchiveError,
    );
  });

  it('texte altéré après coup : refusé (empreinte du manifeste)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legal-archive-16c2-'));
    try {
      cpSync(LEGAL_ARCHIVE_DIR, dir, { recursive: true });
      const copy = new LegalArchive(dir);
      const doc = copy.current(TERMS_OF_USE, 'fr')!;
      writeFileSync(join(dir, doc.file), 'texte modifié\n');
      expect(() => copy.text(doc)).toThrow(LegalArchiveError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LegalAcceptanceService.resolveSubmission', () => {
  const archive = new LegalArchive();
  const service = new LegalAcceptanceService(
    {} as Model<LegalAcceptanceDocument>,
    {} as Model<LegalDocumentVersionDocument>,
    {} as Connection,
    () => new Date('2030-01-01T00:00:00Z'),
    archive,
  );
  const version = (id: string) => archive.currentVersion(id)!;
  const owner = (
    overrides: Partial<LegalAcceptanceDto> = {},
  ): LegalAcceptanceDto => ({
    accepted: true,
    locale: 'fr',
    documents: [
      { id: TERMS_OF_USE, version: version(TERMS_OF_USE) },
      { id: SUBSCRIPTION_TERMS, version: version(SUBSCRIPTION_TERMS) },
    ],
    notices: [{ id: PRIVACY_NOTICE, version: version(PRIVACY_NOTICE) }],
    ...overrides,
  });
  const codeOf = (fn: () => unknown): { status: number; code: unknown } => {
    try {
      fn();
    } catch (err) {
      if (err instanceof HttpException) {
        return {
          status: err.getStatus(),
          code: (err.getResponse() as { code?: unknown }).code,
        };
      }
      throw err;
    }
    throw new Error('aucune erreur');
  };
  const resolve = (input: LegalAcceptanceDto | undefined) =>
    service.resolveSubmission(LegalAcceptanceContext.OWNER_REGISTRATION, input);

  it('absente ou case non cochée : 400 LEGAL_ACCEPTANCE_REQUIRED', () => {
    expect(codeOf(() => resolve(undefined))).toEqual({
      status: 400,
      code: LEGAL_ACCEPTANCE_REQUIRED,
    });
    expect(codeOf(() => resolve(owner({ accepted: false })))).toEqual({
      status: 400,
      code: LEGAL_ACCEPTANCE_REQUIRED,
    });
  });

  it('conditions d’abonnement manquantes pour le propriétaire : 400 REQUIRED', () => {
    const input = owner();
    input.documents = input.documents.slice(0, 1);
    expect(codeOf(() => resolve(input))).toEqual({
      status: 400,
      code: LEGAL_ACCEPTANCE_REQUIRED,
    });
  });

  it('document inconnu, en double, ou information manquante : 400', () => {
    const extra = owner();
    extra.documents.push({ id: 'mentions-legales', version: '0.2' });
    expect(codeOf(() => resolve(extra)).code).toBe(LEGAL_DOCUMENTS_INVALID);
    const dup = owner();
    dup.documents.push({ ...dup.documents[0] });
    expect(codeOf(() => resolve(dup)).code).toBe(LEGAL_DOCUMENTS_INVALID);
    const swapped = owner();
    swapped.notices = [];
    expect(codeOf(() => resolve(swapped)).code).toBe(LEGAL_ACCEPTANCE_REQUIRED);
    // La politique de confidentialité n'est jamais « acceptée ».
    const privacyAccepted = owner();
    privacyAccepted.documents.push({
      id: PRIVACY_NOTICE,
      version: version(PRIVACY_NOTICE),
    });
    expect(codeOf(() => resolve(privacyAccepted)).code).toBe(
      LEGAL_DOCUMENTS_INVALID,
    );
  });

  it('version différente de la version en vigueur : 409 LEGAL_VERSION_OUTDATED', () => {
    const input = owner();
    input.documents[0] = { id: TERMS_OF_USE, version: '0.2' };
    let caught: unknown;
    try {
      resolve(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const body = (caught as ConflictException).getResponse() as {
      code: string;
      current: { id: string; version: string }[];
    };
    expect(body.code).toBe(LEGAL_VERSION_OUTDATED);
    expect(body.current).toContainEqual({
      id: TERMS_OF_USE,
      version: version(TERMS_OF_USE),
    });
  });

  it('traduction inexistante : 400 LEGAL_LOCALE_UNAVAILABLE (rien d’enregistrable)', () => {
    expect(codeOf(() => resolve(owner({ locale: 'de' })))).toEqual({
      status: 400,
      code: LEGAL_LOCALE_UNAVAILABLE,
    });
  });

  it('1-16G : acceptation en anglais, empreintes de la version anglaise', () => {
    const submission = resolve(owner({ locale: 'en' }));
    for (const doc of [...submission.documents, ...submission.notices]) {
      expect(doc.locale).toBe('en');
      expect(doc.sha256).toBe(archive.current(doc.documentId, 'en')!.sha256);
    }
  });

  it('succès : versions, langue et empreintes viennent du manifeste', () => {
    const submission = resolve(owner());
    expect(submission.documents.map((d) => d.documentId)).toEqual([
      TERMS_OF_USE,
      SUBSCRIPTION_TERMS,
    ]);
    for (const doc of [...submission.documents, ...submission.notices]) {
      expect(doc.sha256).toBe(archive.current(doc.documentId, 'fr')!.sha256);
      expect(doc.locale).toBe('fr');
    }
  });

  it('invitation : seules les conditions d’utilisation sont acceptées', () => {
    const input = owner();
    expect(
      codeOf(() =>
        service.resolveSubmission(
          LegalAcceptanceContext.INVITATION_ACCOUNT,
          input,
        ),
      ).code,
    ).toBe(LEGAL_DOCUMENTS_INVALID);
    input.documents = input.documents.slice(0, 1);
    expect(
      service
        .resolveSubmission(LegalAcceptanceContext.INVITATION_ACCOUNT, input)
        .documents.map((d) => d.documentId),
    ).toEqual([TERMS_OF_USE]);
  });

  it('archive absente ou altérée : 503 LEGAL_ARCHIVE_UNAVAILABLE, jamais une acceptation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legal-archive-16c2-'));
    try {
      cpSync(LEGAL_ARCHIVE_DIR, dir, { recursive: true });
      const broken = new LegalArchive(dir);
      writeFileSync(
        join(dir, broken.current(SUBSCRIPTION_TERMS, 'fr')!.file),
        'altéré\n',
      );
      const s = new LegalAcceptanceService(
        {} as Model<LegalAcceptanceDocument>,
        {} as Model<LegalDocumentVersionDocument>,
        {} as Connection,
        () => new Date(),
        broken,
      );
      let caught: unknown;
      try {
        s.resolveSubmission(LegalAcceptanceContext.OWNER_REGISTRATION, owner());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect(
        ((caught as HttpException).getResponse() as { code: string }).code,
      ).toBe(LEGAL_ARCHIVE_UNAVAILABLE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('erreurs de validation : BadRequestException', () => {
    expect(() => resolve(undefined)).toThrow(BadRequestException);
  });
});

describe('legalAcceptanceKey (rejeu)', () => {
  const base = {
    userId: '0123456789abcdef01234567',
    organizationId: 'abcdef0123456789abcdef01',
    context: LegalAcceptanceContext.OWNER_REGISTRATION,
  };
  it('déterministe et indépendante de l’ordre des documents', () => {
    const a = legalAcceptanceKey({
      ...base,
      documents: [
        { documentId: TERMS_OF_USE, version: '0.3' },
        { documentId: SUBSCRIPTION_TERMS, version: '0.3' },
      ],
    });
    const b = legalAcceptanceKey({
      ...base,
      documents: [
        { documentId: SUBSCRIPTION_TERMS, version: '0.3' },
        { documentId: TERMS_OF_USE, version: '0.3' },
      ],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('change avec la version, le commerce ou l’utilisateur', () => {
    const docs = [{ documentId: TERMS_OF_USE, version: '0.3' }];
    const k = legalAcceptanceKey({ ...base, documents: docs });
    expect(
      legalAcceptanceKey({
        ...base,
        documents: [{ documentId: TERMS_OF_USE, version: '0.4' }],
      }),
    ).not.toBe(k);
    expect(
      legalAcceptanceKey({ ...base, organizationId: null, documents: docs }),
    ).not.toBe(k);
    expect(
      legalAcceptanceKey({
        ...base,
        userId: 'ffffffffffffffffffffffff',
        documents: docs,
      }),
    ).not.toBe(k);
  });
});
