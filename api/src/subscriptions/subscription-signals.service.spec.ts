import { Types } from 'mongoose';
import {
  SubscriptionSignal,
  SubscriptionSignalEmitter,
  SubscriptionSignalsService,
} from './subscription-signals.service';

/**
 * 1-15F — destinataires et best effort des signaux d'abonnement et de
 * paiement (payload `{}`) : propriétaire actif réel seul, lu en base au
 * moment de l'émission.
 */

const ORG = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OWNER = new Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb');

/** Chaîne Mongoose `…select().lean().exec()` renvoyant `result`. */
const chain = (result: () => Promise<unknown>) => ({
  select: () => ({ lean: () => ({ exec: result }) }),
});

function build(
  options: {
    organization?: { status: string } | null;
    owner?: { userId: Types.ObjectId } | null;
    organizationError?: boolean;
  } = {},
) {
  const organizationModel = {
    findById: jest.fn(() =>
      chain(() =>
        options.organizationError
          ? Promise.reject(new Error('lecture impossible'))
          : Promise.resolve(
              options.organization === undefined
                ? { status: 'active' }
                : options.organization,
            ),
      ),
    ),
  };
  const membershipModel = {
    findOne: jest.fn(() =>
      chain(() =>
        Promise.resolve(
          options.owner === undefined ? { userId: OWNER } : options.owner,
        ),
      ),
    ),
  };
  const service = new SubscriptionSignalsService(
    organizationModel as never,
    membershipModel as never,
  );
  // Fonction autonome : assertions sans méthode détachée.
  const toMember = jest.fn();
  const emitter: SubscriptionSignalEmitter = { toMember };
  return { service, emitter, toMember, organizationModel, membershipModel };
}

const SIGNALS: Array<
  [SubscriptionSignal, 'subscriptionChanged' | 'paymentsChanged']
> = [
  ['subscription:changed', 'subscriptionChanged'],
  ['payments:changed', 'paymentsChanged'],
];

describe('SubscriptionSignalsService (1-15F)', () => {
  it('sans passerelle : aucun effet, aucune lecture', async () => {
    const { service, organizationModel, membershipModel } = build();
    await service.subscriptionChanged(ORG);
    await service.paymentsChanged(ORG);
    expect(organizationModel.findById).not.toHaveBeenCalled();
    expect(membershipModel.findOne).not.toHaveBeenCalled();
  });

  it.each(SIGNALS)(
    '%s → propriétaire ACTIF réel seul (rôle lu en base), payload vide',
    async (event, method) => {
      const { service, emitter, toMember, membershipModel } = build();
      service.attachEmitter(emitter);
      await service[method](ORG);
      expect(membershipModel.findOne).toHaveBeenCalledWith({
        organizationId: new Types.ObjectId(ORG),
        role: 'owner',
        status: 'active',
      });
      expect(toMember).toHaveBeenCalledTimes(1);
      expect(toMember).toHaveBeenCalledWith(
        ORG,
        OWNER.toHexString(),
        event,
        {},
      );
    },
  );

  it.each(SIGNALS)(
    '%s : aucun propriétaire actif → aucun signal',
    async (_event, method) => {
      const { service, emitter, toMember } = build({ owner: null });
      service.attachEmitter(emitter);
      await service[method](ORG);
      expect(toMember).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['suspendue', { status: 'suspended' }],
    ['absente', null],
  ])(
    'organisation %s → aucun signal (suspension prioritaire)',
    async (_label, organization) => {
      const { service, emitter, toMember, membershipModel } = build({
        organization,
      });
      service.attachEmitter(emitter);
      await service.subscriptionChanged(ORG);
      await service.paymentsChanged(ORG);
      expect(toMember).not.toHaveBeenCalled();
      expect(membershipModel.findOne).not.toHaveBeenCalled();
    },
  );

  it('panne d’émission ou de lecture : jamais propagée', async () => {
    const failing = build();
    failing.toMember.mockImplementation(() => {
      throw new Error('socket');
    });
    failing.service.attachEmitter(failing.emitter);
    await expect(failing.service.subscriptionChanged(ORG)).resolves.toBe(
      undefined,
    );
    await expect(failing.service.paymentsChanged(ORG)).resolves.toBe(undefined);

    const unreadable = build({ organizationError: true });
    unreadable.service.attachEmitter(unreadable.emitter);
    await expect(unreadable.service.subscriptionChanged(ORG)).resolves.toBe(
      undefined,
    );
    await expect(unreadable.service.paymentsChanged(ORG)).resolves.toBe(
      undefined,
    );
    expect(unreadable.toMember).not.toHaveBeenCalled();
  });
});
