import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { OrganizationRole } from '../organizations/permissions';
import type { LegalAcceptanceDto } from './dto/legal-acceptance.dto';
import {
  LEGAL_DEFAULT_LOCALE,
  LEGAL_REQUIREMENTS,
  LegalAcceptanceContext,
  LegalArchive,
  LegalArchiveError,
  PRIVACY_NOTICE,
  type ResolvedLegalDocument,
  SUBSCRIPTION_TERMS,
  TERMS_OF_USE,
  sha256Hex,
} from './legal-documents';
import {
  LegalAcceptance,
  type LegalAcceptanceDocument,
  type LegalDocumentProof,
  LegalDocumentVersion,
  type LegalDocumentVersionDocument,
} from './schemas/legal-acceptance.schema';

type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;

export const LEGAL_CLOCK = Symbol('LEGAL_CLOCK');
export type LegalClock = () => Date;
export const LEGAL_ARCHIVE = Symbol('LEGAL_ARCHIVE');

export const LEGAL_ACCEPTANCE_REQUIRED = 'LEGAL_ACCEPTANCE_REQUIRED';
export const LEGAL_DOCUMENTS_INVALID = 'LEGAL_DOCUMENTS_INVALID';
export const LEGAL_LOCALE_UNAVAILABLE = 'LEGAL_LOCALE_UNAVAILABLE';
export const LEGAL_VERSION_OUTDATED = 'LEGAL_VERSION_OUTDATED';
export const LEGAL_ARCHIVE_UNAVAILABLE = 'LEGAL_ARCHIVE_UNAVAILABLE';

/**
 * Invite des comptes EXISTANTS dans l'application : désactivée par défaut,
 * seule la valeur exacte `true` l'active (même convention que
 * `PUBLIC_REGISTRATION_ENABLED`). L'acceptation exigée à l'inscription et à
 * la création d'un compte par invitation ne dépend PAS de ce drapeau.
 */
export function isLegalAcceptancePromptEnabled(): boolean {
  return process.env.LEGAL_ACCEPTANCE_PROMPT_ENABLED === 'true';
}

export interface LegalDocumentRef {
  id: string;
  version: string;
}

/** Soumission validée : documents résolus DEPUIS LE MANIFESTE. */
export interface ResolvedLegalSubmission {
  context: LegalAcceptanceContext;
  locale: string;
  documents: ResolvedLegalDocument[];
  notices: ResolvedLegalDocument[];
}

export interface LegalAcceptanceStatus {
  promptEnabled: boolean;
  locale: string;
  pending: LegalDocumentRef[];
  notices: LegalDocumentRef[];
}

function required(message: string) {
  return new BadRequestException({ code: LEGAL_ACCEPTANCE_REQUIRED, message });
}

function invalid() {
  return new BadRequestException({
    code: LEGAL_DOCUMENTS_INVALID,
    message: 'Les documents indiqués ne correspondent pas à ce parcours.',
  });
}

function archiveUnavailable() {
  return new ServiceUnavailableException({
    code: LEGAL_ARCHIVE_UNAVAILABLE,
    message:
      "L'enregistrement de l'acceptation est momentanément indisponible.",
  });
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 11000
  );
}

/** `_id` de la preuve : un rejeu de la même acceptation retombe dessus. */
export function legalAcceptanceKey(input: {
  userId: string;
  organizationId: string | null;
  context: LegalAcceptanceContext;
  documents: readonly { documentId: string; version: string }[];
}): string {
  const accepted = input.documents
    .map((d) => `${d.documentId}@${d.version}`)
    .sort();
  return sha256Hex(
    JSON.stringify([
      input.userId,
      input.organizationId,
      input.context,
      accepted,
    ]),
  );
}

export function legalArchiveId(doc: ResolvedLegalDocument): string {
  return `${doc.documentId}@${doc.version}/${doc.locale}`;
}

@Injectable()
export class LegalAcceptanceService {
  constructor(
    @InjectModel(LegalAcceptance.name)
    private readonly acceptanceModel: Model<LegalAcceptanceDocument>,
    @InjectModel(LegalDocumentVersion.name)
    private readonly versionModel: Model<LegalDocumentVersionDocument>,
    @InjectConnection() private readonly connection: Connection,
    @Inject(LEGAL_CLOCK) private readonly clock: LegalClock,
    @Inject(LEGAL_ARCHIVE) private readonly archive: LegalArchive,
  ) {}

  /**
   * Vérifie une soumission AVANT toute écriture : case cochée, documents
   * exactement attendus pour ce parcours, langue publiée, versions en
   * vigueur. Les versions, langues et empreintes retournées viennent du
   * manifeste, jamais du client.
   */
  resolveSubmission(
    context: LegalAcceptanceContext,
    input: LegalAcceptanceDto | undefined,
    expected: { documents: readonly string[]; notices: readonly string[] } = (
      LEGAL_REQUIREMENTS as Record<
        string,
        { documents: readonly string[]; notices: readonly string[] }
      >
    )[context],
  ): ResolvedLegalSubmission {
    if (!input || input.accepted !== true) {
      throw required("L'acceptation des conditions est requise.");
    }
    const check = (
      refs: readonly LegalDocumentRef[],
      ids: readonly string[],
    ) => {
      const seen = new Set(refs.map((r) => r.id));
      if (seen.size !== refs.length) throw invalid();
      for (const r of refs) if (!ids.includes(r.id)) throw invalid();
      for (const id of ids) {
        if (!seen.has(id)) {
          throw required("L'acceptation des conditions est requise.");
        }
      }
    };
    check(input.documents, expected.documents);
    check(input.notices, expected.notices);

    const resolveAll = (refs: readonly LegalDocumentRef[]) =>
      refs.map((ref) => {
        let doc: ResolvedLegalDocument | null;
        try {
          doc = this.archive.current(ref.id, input.locale);
          if (!doc && this.archive.currentVersion(ref.id) === null) {
            throw new LegalArchiveError(`Document non archivé : ${ref.id}`);
          }
        } catch (err) {
          if (err instanceof LegalArchiveError) throw archiveUnavailable();
          throw err;
        }
        if (!doc) {
          throw new BadRequestException({
            code: LEGAL_LOCALE_UNAVAILABLE,
            message: "Ces conditions n'existent pas dans cette langue.",
          });
        }
        return { ref, doc };
      });
    const documents = resolveAll(input.documents);
    const notices = resolveAll(input.notices);
    const outdated = [...documents, ...notices].filter(
      ({ ref, doc }) => ref.version !== doc.version,
    );
    if (outdated.length > 0) {
      throw new ConflictException({
        code: LEGAL_VERSION_OUTDATED,
        message:
          'Les conditions ont été mises à jour : recharge la page pour lire la version en vigueur.',
        current: [...documents, ...notices].map(({ doc }) => ({
          id: doc.documentId,
          version: doc.version,
        })),
      });
    }
    // Texte présent et intact AVANT toute écriture.
    for (const { doc } of [...documents, ...notices]) this.verifiedText(doc);
    return {
      context,
      locale: input.locale,
      documents: documents.map((d) => d.doc),
      notices: notices.map((d) => d.doc),
    };
  }

  /**
   * Enregistre la preuve dans la session de l'appelant (même transaction que
   * la création du compte) : archive chaque texte (sans jamais réécrire une
   * version), puis insère la preuve. Date = horloge du serveur.
   */
  async record(
    session: MongooseSession,
    input: {
      userId: string;
      organizationId: string | null;
      submission: ResolvedLegalSubmission;
    },
  ): Promise<LegalAcceptanceDocument> {
    const now = this.clock();
    const proofs = async (docs: ResolvedLegalDocument[]) => {
      const out: LegalDocumentProof[] = [];
      for (const doc of docs) {
        out.push({
          documentId: doc.documentId,
          version: doc.version,
          locale: doc.locale,
          sha256: doc.sha256,
          archiveId: await this.archiveVersion(session, doc, now),
        });
      }
      return out;
    };
    const acceptedDocuments = await proofs(input.submission.documents);
    const presentedNotices = await proofs(input.submission.notices);
    const [created] = await this.acceptanceModel.create(
      [
        {
          _id: legalAcceptanceKey({
            userId: input.userId,
            organizationId: input.organizationId,
            context: input.submission.context,
            documents: acceptedDocuments,
          }),
          userId: new Types.ObjectId(input.userId),
          organizationId: input.organizationId
            ? new Types.ObjectId(input.organizationId)
            : null,
          context: input.submission.context,
          acceptedAt: now,
          locale: input.submission.locale,
          acceptedDocuments,
          presentedNotices,
        },
      ],
      { session },
    );
    return created;
  }

  /**
   * Documents en vigueur que ce compte n'a pas acceptés : conditions
   * d'utilisation pour tous, conditions d'abonnement pour le PROPRIÉTAIRE
   * de ce commerce. Une acceptation d'une autre langue de la même version
   * compte. Aucune acceptation n'est déduite d'autre chose qu'une preuve.
   */
  async status(
    userId: string,
    organizationId: string,
    role: OrganizationRole,
  ): Promise<LegalAcceptanceStatus> {
    const pending: LegalDocumentRef[] = [];
    const ids = [TERMS_OF_USE];
    if (role === OrganizationRole.OWNER) ids.push(SUBSCRIPTION_TERMS);
    for (const id of ids) {
      const version = this.currentVersionOrUnavailable(id);
      const accepted = await this.acceptanceModel.exists({
        userId: new Types.ObjectId(userId),
        ...(id === SUBSCRIPTION_TERMS
          ? { organizationId: new Types.ObjectId(organizationId) }
          : {}),
        acceptedDocuments: { $elemMatch: { documentId: id, version } },
      });
      if (!accepted) pending.push({ id, version });
    }
    return {
      promptEnabled: isLegalAcceptancePromptEnabled(),
      locale: LEGAL_DEFAULT_LOCALE,
      pending,
      notices:
        pending.length > 0
          ? [
              {
                id: PRIVACY_NOTICE,
                version: this.currentVersionOrUnavailable(PRIVACY_NOTICE),
              },
            ]
          : [],
    };
  }

  /**
   * Confirmation explicite d'un compte existant. Rien en attente : aucune
   * nouvelle preuve (`already-accepted`). Sinon la soumission doit couvrir
   * EXACTEMENT les documents en attente, en version courante. Un rejeu
   * concurrent retombe sur la même preuve (`_id` déterministe).
   */
  async confirm(
    userId: string,
    organizationId: string,
    role: OrganizationRole,
    input: LegalAcceptanceDto,
  ): Promise<{
    status: 'recorded' | 'already-accepted';
    acceptedAt: Date | null;
  }> {
    const current = await this.status(userId, organizationId, role);
    if (current.pending.length === 0) {
      if (input.accepted !== true) {
        throw required("L'acceptation des conditions est requise.");
      }
      return { status: 'already-accepted', acceptedAt: null };
    }
    const submission = this.resolveSubmission(
      LegalAcceptanceContext.ACCOUNT_CONFIRMATION,
      input,
      {
        documents: current.pending.map((p) => p.id),
        notices: current.notices.map((n) => n.id),
      },
    );
    const session = await this.connection.startSession();
    let acceptedAt: Date | null = null;
    try {
      await session.withTransaction(async () => {
        const created = await this.record(session, {
          userId,
          organizationId,
          submission,
        });
        acceptedAt = created.acceptedAt;
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return { status: 'already-accepted', acceptedAt: null };
      }
      throw err;
    } finally {
      await session.endSession();
    }
    return { status: 'recorded', acceptedAt };
  }

  private currentVersionOrUnavailable(id: string): string {
    try {
      const version = this.archive.currentVersion(id);
      if (version === null) throw new LegalArchiveError(id);
      return version;
    } catch (err) {
      if (err instanceof LegalArchiveError) throw archiveUnavailable();
      throw err;
    }
  }

  private verifiedText(doc: ResolvedLegalDocument): string {
    try {
      return this.archive.text(doc);
    } catch (err) {
      if (err instanceof LegalArchiveError) throw archiveUnavailable();
      throw err;
    }
  }

  /**
   * Archive le texte d'une version en base, à sa première acceptation
   * (`$setOnInsert` : jamais de réécriture). Une version déjà archivée
   * avec un autre contenu refuse toute nouvelle acceptation.
   */
  private async archiveVersion(
    session: MongooseSession,
    doc: ResolvedLegalDocument,
    now: Date,
  ): Promise<string> {
    const id = legalArchiveId(doc);
    const text = this.verifiedText(doc);
    const collection = this.versionModel.collection;
    await collection.updateOne(
      { _id: id as never },
      {
        $setOnInsert: {
          documentId: doc.documentId,
          version: doc.version,
          locale: doc.locale,
          sha256: doc.sha256,
          text,
          publishedAt: doc.publishedAt,
          archivedAt: now,
        },
      },
      { upsert: true, session },
    );
    const stored = await collection.findOne({ _id: id as never }, { session });
    if (
      !stored ||
      stored.sha256 !== doc.sha256 ||
      typeof stored.text !== 'string' ||
      sha256Hex(stored.text) !== doc.sha256
    ) {
      throw archiveUnavailable();
    }
    return id;
  }
}
