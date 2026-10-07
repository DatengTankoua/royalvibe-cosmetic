import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  EMAIL_SENDER,
  EmailDeliveryError,
  type EmailSender,
} from '../email-verification/email-sender';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import { effectivePermissions } from '../organizations/permissions';
import { User, UserDocument } from '../users/schemas/user.schema';
import type { CreateSupportRequestDto } from './dto/create-support-request.dto';
import {
  SupportRequest,
  SupportRequestContext,
  SupportRequestDocument,
  SupportRequestStatus,
} from './schemas/support-request.schema';
import { buildSupportEmail } from './support-email';
import {
  SUPPORT_CLOCK,
  SUPPORT_RECIPIENT,
  SUPPORT_SEND_LOCK_MS,
  SUPPORT_UNCERTAIN_RETRY_WINDOW_MS,
  type SupportCategory,
  type SupportClock,
} from './support-constants';

/** Contexte affiché AVANT l'envoi : exactement ce que le serveur joindra. */
export interface SupportContextView {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string | null };
  membership: { id: string; role: string; permissions: string[] };
}

export interface SupportSubmitResult {
  reference: string;
  status: 'sent';
  createdAt: string;
  /** `true` : intention déjà acceptée par le transport, rien de renvoyé. */
  replayed: boolean;
}

const DUPLICATE_KEY = 11000;

/** Référence lisible, dérivée de l'UUID d'intention (stable sur les rejeux). */
export function supportReference(requestId: string): string {
  return `AS-${createHash('sha256').update(requestId).digest('hex').slice(0, 8).toUpperCase()}`;
}

interface NormalizedContent {
  category: SupportCategory;
  subject: string;
  message: string;
  page: string | null;
  appVersion: string | null;
}

export function supportFingerprint(content: NormalizedContent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        content.category,
        content.subject,
        content.message,
        content.page,
        content.appVersion,
      ]),
    )
    .digest('hex');
}

/**
 * Classement d'un échec du transport :
 * - `failed` : refus certain, rien n'a été accepté (configuration absente,
 *   4xx hors 409, 429) → renvoi sans risque ;
 * - `unknown` : résultat inconnu (délai, réseau, 5xx, 409 d'idempotence,
 *   erreur inattendue) → renvoi seulement avec la même clé, dans la
 *   fenêtre de 24 h du prestataire.
 */
export function classifyDeliveryFailure(error: unknown): 'failed' | 'unknown' {
  if (!(error instanceof EmailDeliveryError)) return 'unknown';
  if (error.reason === 'not_configured') return 'failed';
  if (error.reason === 'timeout' || error.reason === 'network') {
    return 'unknown';
  }
  const status = error.providerStatus;
  if (status === undefined) return 'failed';
  if (status === 409 || status >= 500) return 'unknown';
  return 'failed';
}

/**
 * 1-16C.1 — Demandes d'assistance envoyées depuis l'organisation courante.
 *
 * Identité, organisation, rôle et droits : relus en base à partir du
 * contexte serveur (gardes globaux), jamais du corps de la requête.
 * Destinataire fixé (`SUPPORT_RECIPIENT`) ; Reply-To = e-mail du compte.
 * Aucun jeton, mot de passe, clé, vente, contact d'acheteur, fichier,
 * journal ni stockage local n'est joint.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectModel(SupportRequest.name)
    private readonly requests: Model<SupportRequestDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @InjectModel(Organization.name)
    private readonly organizations: Model<OrganizationDocument>,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(SUPPORT_CLOCK) private readonly clock: SupportClock,
  ) {}

  async getContext(
    ctx: ResolvedOrganizationContext,
  ): Promise<SupportContextView> {
    const snapshot = await this.loadContext(ctx);
    return {
      user: {
        id: ctx.userId,
        name: snapshot.userName,
        email: snapshot.userEmail,
      },
      organization: {
        id: ctx.organizationId,
        name: snapshot.organizationName,
        slug: snapshot.organizationSlug,
      },
      membership: {
        id: ctx.membershipId,
        role: snapshot.role,
        permissions: snapshot.permissions,
      },
    };
  }

  private async loadContext(
    ctx: ResolvedOrganizationContext,
  ): Promise<SupportRequestContext> {
    const [user, organization] = await Promise.all([
      this.users
        .findById(ctx.userId)
        .select({ name: 1, email: 1 })
        .lean()
        .exec(),
      this.organizations
        .findById(ctx.organizationId)
        .select({ name: 1, slug: 1 })
        .lean()
        .exec(),
    ]);
    // Les gardes ont déjà vérifié compte et organisation ; défensif.
    if (!user || !organization) throw new NotFoundException();
    return {
      userName: user.name,
      userEmail: user.email,
      organizationName: organization.name,
      organizationSlug: organization.slug ?? null,
      role: ctx.role,
      permissions: [...effectivePermissions(ctx.role, ctx.permissions)].sort(),
    };
  }

  private normalize(dto: CreateSupportRequestDto): NormalizedContent {
    const subject = dto.subject.trim();
    const message = dto.message.replace(/\r\n?/g, '\n').trim();
    if (subject.length === 0 || message.length === 0) {
      throw new BadRequestException({
        code: 'SUPPORT_REQUEST_INVALID',
        message: 'Le sujet et le message sont obligatoires.',
      });
    }
    return {
      category: dto.category,
      subject,
      message,
      page: dto.page ?? null,
      appVersion: dto.appVersion ?? null,
    };
  }

  async submit(
    ctx: ResolvedOrganizationContext,
    dto: CreateSupportRequestDto,
  ): Promise<SupportSubmitResult> {
    const content = this.normalize(dto);
    const fingerprint = supportFingerprint(content);
    const id = dto.requestId.toLowerCase();

    let request = await this.requests.findById(id).lean().exec();
    if (!request) {
      const context = await this.loadContext(ctx);
      try {
        await this.requests.create({
          _id: id,
          reference: supportReference(id),
          userId: new Types.ObjectId(ctx.userId),
          organizationId: new Types.ObjectId(ctx.organizationId),
          membershipId: new Types.ObjectId(ctx.membershipId),
          category: content.category,
          fingerprint,
          page: content.page,
          appVersion: content.appVersion,
          context,
          status: SupportRequestStatus.PENDING,
          createdAt: this.clock(),
        });
      } catch (error) {
        // Création concurrente de la même intention : la première gagne.
        if ((error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
      }
      request = await this.requests.findById(id).lean().exec();
      if (!request) throw new Error('Support request vanished');
    }

    // Une intention appartient à UN utilisateur dans UNE organisation.
    if (
      request.userId.toString() !== ctx.userId ||
      request.organizationId.toString() !== ctx.organizationId
    ) {
      throw new ConflictException({
        code: 'SUPPORT_REQUEST_CONFLICT',
        message: 'Identifiant de demande déjà utilisé.',
      });
    }
    if (request.fingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'SUPPORT_REQUEST_MISMATCH',
        message: 'Cette demande a déjà été envoyée avec un autre contenu.',
      });
    }
    if (request.status === SupportRequestStatus.SENT) {
      return this.result(request, true);
    }

    const now = this.clock();
    const windowStart = new Date(
      now.getTime() - SUPPORT_UNCERTAIN_RETRY_WINDOW_MS,
    );

    // Verrou d'envoi périmé (processus interrompu pendant l'appel) : le
    // résultat est inconnu.
    if (
      request.status === SupportRequestStatus.SENDING &&
      request.lockedUntil &&
      request.lockedUntil.getTime() < now.getTime()
    ) {
      await this.requests.updateOne(
        {
          _id: id,
          status: SupportRequestStatus.SENDING,
          lockedUntil: request.lockedUntil,
        },
        {
          $set: {
            status: SupportRequestStatus.UNKNOWN,
            lockedUntil: null,
            uncertainAt: request.uncertainAt ?? now,
          },
        },
      );
    }

    const claimed = await this.requests
      .findOneAndUpdate(
        {
          _id: id,
          $or: [
            // Jamais d'incertitude : renvoi toujours sûr.
            {
              status: {
                $in: [
                  SupportRequestStatus.PENDING,
                  SupportRequestStatus.FAILED,
                ],
              },
              uncertainAt: null,
            },
            // Incertitude passée : même clé, dans la fenêtre du prestataire.
            {
              status: {
                $in: [
                  SupportRequestStatus.UNKNOWN,
                  SupportRequestStatus.FAILED,
                ],
              },
              uncertainAt: { $ne: null },
              firstAttemptAt: { $gte: windowStart },
            },
          ],
        },
        {
          $set: {
            status: SupportRequestStatus.SENDING,
            lockedUntil: new Date(now.getTime() + SUPPORT_SEND_LOCK_MS),
          },
          $inc: { attempts: 1 },
        },
        { new: true },
      )
      .lean()
      .exec();

    if (!claimed) {
      const current = await this.requests.findById(id).lean().exec();
      if (current?.status === SupportRequestStatus.SENT) {
        return this.result(current, true);
      }
      if (current?.status === SupportRequestStatus.SENDING) {
        throw new ConflictException({
          code: 'SUPPORT_REQUEST_IN_PROGRESS',
          message: 'Cette demande est en cours d’envoi.',
          reference: current.reference,
        });
      }
      // Résultat inconnu au-delà de la fenêtre : aucun renvoi automatique.
      throw new ConflictException({
        code: 'SUPPORT_RETRY_WINDOW_EXPIRED',
        message:
          'Le résultat de l’envoi est inconnu et ne peut plus être vérifié sans risque de doublon.',
        reference: current?.reference ?? request.reference,
      });
    }

    if (!claimed.firstAttemptAt) {
      await this.requests.updateOne(
        { _id: id, firstAttemptAt: null },
        { $set: { firstAttemptAt: now } },
      );
    }

    const email = buildSupportEmail({
      requestId: id,
      reference: claimed.reference,
      createdAt: claimed.createdAt,
      category: claimed.category as SupportCategory,
      subject: content.subject,
      message: content.message,
      page: claimed.page,
      appVersion: claimed.appVersion,
      userId: claimed.userId.toString(),
      organizationId: claimed.organizationId.toString(),
      membershipId: claimed.membershipId.toString(),
      context: claimed.context,
    });

    try {
      await this.sender.send({
        to: SUPPORT_RECIPIENT,
        replyTo: claimed.context.userEmail,
        subject: email.subject,
        text: email.text,
        html: email.html,
        idempotencyKey: `support-request/${id}`,
      });
    } catch (error) {
      const outcome = classifyDeliveryFailure(error);
      await this.requests.updateOne(
        { _id: id, status: SupportRequestStatus.SENDING },
        {
          $set: {
            status:
              outcome === 'unknown'
                ? SupportRequestStatus.UNKNOWN
                : SupportRequestStatus.FAILED,
            lockedUntil: null,
            ...(outcome === 'unknown' && !claimed.uncertainAt
              ? { uncertainAt: now }
              : {}),
          },
        },
      );
      // Journal minimal : jamais le contenu, l'e-mail ni la réponse brute.
      this.logger.warn(
        `Demande d'assistance ${claimed.reference} non confirmée (${outcome}).`,
      );
      throw new ServiceUnavailableException({
        code:
          outcome === 'unknown'
            ? 'SUPPORT_DELIVERY_UNCERTAIN'
            : 'SUPPORT_DELIVERY_UNAVAILABLE',
        message: 'Le message n’a pas pu être transmis pour le moment.',
        reference: claimed.reference,
      });
    }

    const sent = await this.requests
      .findOneAndUpdate(
        { _id: id },
        {
          $set: {
            status: SupportRequestStatus.SENT,
            lockedUntil: null,
            sentAt: this.clock(),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    return this.result(sent ?? claimed, false);
  }

  private result(
    request: Pick<SupportRequest, 'reference' | 'createdAt'>,
    replayed: boolean,
  ): SupportSubmitResult {
    return {
      reference: request.reference,
      status: 'sent',
      createdAt: request.createdAt.toISOString(),
      replayed,
    };
  }
}
