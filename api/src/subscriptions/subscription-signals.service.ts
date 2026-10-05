import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Organization,
  OrganizationDocument,
} from '../organizations/schemas/organization.schema';
import {
  OrganizationMembership,
  OrganizationMembershipDocument,
} from '../organizations/schemas/membership.schema';
import {
  MembershipStatus,
  OrganizationRole,
  OrganizationStatus,
} from '../organizations/permissions';

/**
 * 1-15F — signaux d'abonnement et de paiement : invalidations SANS donnée
 * (`{}`), qui demandent seulement aux écrans autorisés de relire l'API
 * locale. Jamais de montant, téléphone, référence, jeton ni statut.
 * - `subscription:changed` : période attribuée (paiement confirmé) ;
 * - `payments:changed` : paiement créé ou changement d'état effectif.
 */
export type SubscriptionSignal = 'subscription:changed' | 'payments:changed';

/**
 * Émetteur branché par `EventsGateway.afterInit` : sockets de `userId` dans
 * la room `organization:<id>`, couverture d'abonnement valide.
 */
export interface SubscriptionSignalEmitter {
  toMember(
    organizationId: string,
    userId: string,
    event: string,
    payload: unknown,
  ): void;
}

/**
 * 1-15F — pont entre les écritures d'abonnement / de paiement et la
 * passerelle Socket.IO. Fourni et exporté par `SubscriptionsModule` :
 * `EventsModule` l'importe déjà ; `SubscriptionsModule` n'importe ni
 * `OrganizationsModule` ni `EventsModule` (aucune dépendance circulaire).
 *
 * Appelé UNIQUEMENT après une écriture validée (après le commit extérieur
 * pour une transaction), jamais dans un callback rejouable. Best effort :
 * les méthodes ne rejettent jamais ; une panne d'émission ou de lecture des
 * destinataires ne transforme jamais l'écriture en erreur HTTP. Sans
 * passerelle (CLI `createApplicationContext`, tests), aucun effet.
 *
 * Destinataires lus en base AU MOMENT de l'émission (jamais un rôle porté
 * par un jeton ou figé au handshake) :
 * - organisation suspendue → aucun signal (la suspension reste prioritaire) ;
 * - les DEUX signaux → sockets du SEUL propriétaire actif réel
 *   (`membership { role: owner, status: active }`), seuls lecteurs autorisés
 *   (`billing.identity` et `billing.payment` sont owner-only) ; un
 *   administrateur ou un autre membre n'en reçoit aucun.
 *
 * Limite mono-processus : comme le registre des sockets (1-7C), l'émission
 * ne touche que les sockets de CE processus ; une écriture faite par un CLI
 * (autre processus) n'émet rien.
 */
@Injectable()
export class SubscriptionSignalsService {
  private readonly logger = new Logger(SubscriptionSignalsService.name);
  private emitter: SubscriptionSignalEmitter | null = null;

  constructor(
    @InjectModel(Organization.name)
    private readonly organizationModel: Model<OrganizationDocument>,
    @InjectModel(OrganizationMembership.name)
    private readonly membershipModel: Model<OrganizationMembershipDocument>,
  ) {}

  attachEmitter(emitter: SubscriptionSignalEmitter): void {
    this.emitter = emitter;
  }

  /** Période d'abonnement attribuée et validée : propriétaire réel seul. */
  async subscriptionChanged(organizationId: string): Promise<void> {
    await this.toOwner(organizationId, 'subscription:changed');
  }

  /** Paiement créé ou changement d'état validé : propriétaire réel seul. */
  async paymentsChanged(organizationId: string): Promise<void> {
    await this.toOwner(organizationId, 'payments:changed');
  }

  private async toOwner(
    organizationId: string,
    event: SubscriptionSignal,
  ): Promise<void> {
    await this.send(event, async (emitter) => {
      if (!(await this.organizationActive(organizationId))) return;
      const owner = await this.membershipModel
        .findOne({
          organizationId: new Types.ObjectId(organizationId),
          role: OrganizationRole.OWNER,
          status: MembershipStatus.ACTIVE,
        })
        .select({ userId: 1 })
        .lean<{ userId: Types.ObjectId }>()
        .exec();
      if (!owner) return;
      emitter.toMember(organizationId, owner.userId.toHexString(), event, {});
    });
  }

  private async organizationActive(organizationId: string): Promise<boolean> {
    const organization = await this.organizationModel
      .findById(organizationId)
      .select({ status: 1 })
      .lean<{ status: OrganizationStatus }>()
      .exec();
    return organization?.status === OrganizationStatus.ACTIVE;
  }

  private async send(
    event: SubscriptionSignal,
    work: (emitter: SubscriptionSignalEmitter) => Promise<void>,
  ): Promise<void> {
    const emitter = this.emitter;
    if (!emitter) return;
    try {
      await work(emitter);
    } catch {
      this.logger.warn(`${event} non émis (best effort).`);
    }
  }
}
