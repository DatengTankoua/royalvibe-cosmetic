import { Mongoose, Types } from 'mongoose';
import { Reflector } from '@nestjs/core';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  SUBSCRIPTION_PERIODS_COLLECTION,
  SubscriptionPeriod,
  SubscriptionPeriodSchema,
} from './schemas/subscription-period.schema';
import { OrganizationSchema } from '../organizations/schemas/organization.schema';
import { SubscriptionsController } from './subscriptions.controller';
import {
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../auth/decorators/permissions.decorator';
import { parseGrantArguments } from '../migrations/grant-subscription-period';

/** Registre Mongoose local : aucune connexion, aucun index créé. */
const registry = new Mongoose();
const PeriodModel = registry.model(
  SubscriptionPeriod.name,
  SubscriptionPeriodSchema,
);

const base = () => ({
  organizationId: new Types.ObjectId(),
  sequence: 1,
  kind: 'subscription',
  term: 'monthly',
  startsAt: new Date('2026-01-01T00:00:00.000Z'),
  endsAt: new Date('2026-02-01T00:00:00.000Z'),
  source: 'manual',
  sourceReference: 'REC-1',
  grantedBy: 'ops',
});

async function errorsOf(doc: Record<string, unknown>): Promise<string[]> {
  try {
    await new PeriodModel(doc).validate();
    return [];
  } catch (error) {
    return Object.keys((error as { errors?: object }).errors ?? {}).sort();
  }
}

describe('SubscriptionPeriod schema (1-14B)', () => {
  it('collection dédiée, autoIndex désactivé, aucun index déclaré au schéma', () => {
    expect(SubscriptionPeriodSchema.get('collection')).toBe(
      SUBSCRIPTION_PERIODS_COLLECTION,
    );
    expect(SubscriptionPeriodSchema.get('autoIndex')).toBe(false);
    expect(SubscriptionPeriodSchema.indexes()).toEqual([]);
  });

  it('abonnement valide ; essai valide (term null, source trial)', async () => {
    expect(await errorsOf(base())).toEqual([]);
    expect(
      await errorsOf({
        ...base(),
        kind: 'trial',
        term: null,
        source: 'trial',
        sourceReference: 'trial:x',
        grantedBy: 'system',
      }),
    ).toEqual([]);
  });

  it('champs requis (term requis par défaut : kind absent ≠ essai)', async () => {
    expect(await errorsOf({})).toEqual(
      [
        'term',
        'endsAt',
        'grantedBy',
        'kind',
        'organizationId',
        'sequence',
        'source',
        'sourceReference',
        'startsAt',
      ].sort(),
    );
  });

  it.each([
    ['term inconnu', { term: 'weekly' }, ['term']],
    ['abonnement sans term', { term: null }, ['term']],
    ['essai avec term', { kind: 'trial', source: 'trial' }, ['term']],
    ['source incohérente', { source: 'trial' }, ['source']],
    ['essai en source manual', { kind: 'trial', term: null }, ['source']],
    [
      'endsAt = startsAt',
      { endsAt: new Date('2026-01-01T00:00:00.000Z') },
      ['endsAt'],
    ],
    [
      'endsAt avant startsAt',
      { endsAt: new Date('2025-12-01T00:00:00.000Z') },
      ['endsAt'],
    ],
    ['sequence 0', { sequence: 0 }, ['sequence']],
    ['sequence non entière', { sequence: 1.5 }, ['sequence']],
    ['référence vide', { sourceReference: '   ' }, ['sourceReference']],
    [
      'référence trop longue',
      { sourceReference: 'x'.repeat(201) },
      ['sourceReference'],
    ],
    ['opérateur trop long', { grantedBy: 'x'.repeat(101) }, ['grantedBy']],
  ])('%s → refusé', async (_label, patch, fields) => {
    expect(await errorsOf({ ...base(), ...patch })).toEqual(fields);
  });

  it('Organization inchangé : aucun champ abonnement', () => {
    const paths = Object.keys(OrganizationSchema.paths).sort();
    expect(paths).toEqual(
      [
        '_id',
        'brandColor',
        'createdAt',
        'currency',
        'logoKey',
        'logoStorage',
        'name',
        'slug',
        'status',
        'updatedAt',
      ].sort(),
    );
  });
});

describe('SubscriptionsController (1-14B) — surface', () => {
  const reflector = new Reflector();
  const proto = SubscriptionsController.prototype as unknown as Record<
    string,
    unknown
  >;

  it('préfixe organizations/current/subscription ; une seule route GET', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SubscriptionsController)).toBe(
      'organizations/current/subscription',
    );
    const routes = Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor')
      .filter(
        (name) =>
          Reflect.getMetadata(METHOD_METADATA, proto[name] as object) !==
          undefined,
      );
    expect(routes).toEqual(['current']);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.current as object)).toBe(
      RequestMethod.GET,
    );
  });

  it('owner-only billing.identity, aucune permission délégable', () => {
    const handler = proto.current as () => unknown;
    expect(reflector.get(OWNER_ONLY_KEY, handler)).toBe('billing.identity');
    expect(reflector.get(PERMISSIONS_KEY, handler)).toBeUndefined();
  });
});

describe('parseGrantArguments (1-14B)', () => {
  const ok = [
    '--organization-id=0123456789abcdef01234567',
    '--term=monthly',
    '--reference=REC-1',
    '--operator=ops',
  ];

  it('4 arguments requis (séparateur `--` toléré)', () => {
    expect(parseGrantArguments(['--', ...ok])).toEqual({
      organizationId: '0123456789abcdef01234567',
      term: 'monthly',
      sourceReference: 'REC-1',
      grantedBy: 'ops',
    });
  });

  it.each([
    ['manquant', ok.slice(1)],
    ['inconnu', [...ok, '--starts-at=2020-01-01']],
    ['dupliqué', [...ok, '--term=annual']],
    ['sans =', [...ok.slice(1), '--organization-id']],
  ])('argument %s → null', (_label, argv) => {
    expect(parseGrantArguments(argv)).toBeNull();
  });
});
