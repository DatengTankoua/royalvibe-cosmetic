/**
 * Phase 1-6B.1 — tests unitaires du schéma OrganizationInvitation.
 * Exécutés SANS connexion MongoDB (registre Mongoose local, comme
 * `membership.schema.spec.ts`) : validation via `doc.validate()` et
 * vérification de la déclaration d'index sur le schéma.
 */
import { Mongoose, Types } from 'mongoose';
import {
  OrganizationInvitation,
  OrganizationInvitationSchema,
} from './invitation.schema';

type InvitationInstance = {
  organizationId: Types.ObjectId | undefined;
  email: string | undefined;
  role: string | undefined;
  permissions: string[];
  tokenHash: string | undefined;
  invitedById: Types.ObjectId | undefined;
  status: string | undefined;
  expiresAt: Date | undefined;
  acceptedAt: Date | null;
  validate(): Promise<unknown>;
};

const expectInvalid = async (
  doc: InvitationInstance,
  re?: RegExp,
): Promise<void> => {
  let err: { name?: string; message?: string } | undefined;
  let rejected = false;
  try {
    await doc.validate();
  } catch (reason) {
    err = reason as { name?: string; message?: string };
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(err?.name).toBe('ValidationError');
  if (re) expect(err?.message).toMatch(re);
};

const expectValid = async (doc: InvitationInstance): Promise<void> => {
  await expect(doc.validate()).resolves.toBeUndefined();
};

let iModel: new (doc?: Record<string, unknown>) => InvitationInstance;

beforeAll(() => {
  const registry = new Mongoose();
  iModel = registry.model(
    OrganizationInvitation.name,
    OrganizationInvitationSchema,
  );
});

describe('OrganizationInvitationSchema', () => {
  const oid = () => new Types.ObjectId();
  const REQUIRED = () => ({
    organizationId: oid(),
    email: 'a@b.co',
    role: 'admin',
    tokenHash: 'a'.repeat(64),
    invitedById: oid(),
    expiresAt: new Date(),
  });
  const invitation = (fields: Record<string, unknown> = {}) =>
    new iModel({ ...REQUIRED(), ...fields });

  it('déclare les timestamps', () => {
    expect(OrganizationInvitationSchema.options.timestamps).toBe(true);
  });

  it('applique les valeurs par défaut (status pending, permissions [], acceptedAt null)', () => {
    const inv = invitation();
    expect(inv.status).toBe('pending');
    expect(inv.permissions).toEqual([]);
    expect(inv.acceptedAt).toBeNull();
  });

  it('normalise email en lowercase/trim', () => {
    const inv = invitation({ email: '  Ada@Example.COM  ' });
    expect(inv.email).toBe('ada@example.com');
  });

  it('exige organizationId, email, role, tokenHash, invitedById, expiresAt', async () => {
    await expectInvalid(
      new iModel({ ...REQUIRED(), organizationId: undefined }),
    );
    await expectInvalid(new iModel({ ...REQUIRED(), email: undefined }));
    await expectInvalid(new iModel({ ...REQUIRED(), role: undefined }));
    await expectInvalid(new iModel({ ...REQUIRED(), tokenHash: undefined }));
    await expectInvalid(new iModel({ ...REQUIRED(), invitedById: undefined }));
    await expectInvalid(new iModel({ ...REQUIRED(), expiresAt: undefined }));
  });

  it('rôle : admin/seller valides, owner et rôle inconnu invalides', async () => {
    await expectValid(invitation({ role: 'admin' }));
    await expectValid(invitation({ role: 'seller' }));
    await expectInvalid(invitation({ role: 'owner' }), /role/);
    await expectInvalid(invitation({ role: 'supplier' }), /role/);
  });

  it('statut : les 4 valeurs du cycle de vie sont acceptées, une valeur inconnue refusée', async () => {
    for (const status of ['pending', 'accepted', 'revoked', 'expired']) {
      await expectValid(invitation({ status }));
    }
    await expectInvalid(invitation({ status: 'deleted' }));
  });

  it('refuse une permission inconnue (y compris une opération owner-only)', async () => {
    await expectInvalid(
      invitation({ permissions: ['nope.permission'] }),
      /permissions/,
    );
    await expectInvalid(
      invitation({ permissions: ['ownership.transfer'] }),
      /permissions/,
    );
    await expectValid(invitation({ permissions: ['analytics.read'] }));
  });

  it('refuse les permissions dupliquées', async () => {
    await expectInvalid(
      invitation({ permissions: ['analytics.read', 'analytics.read'] }),
      /permissions/,
    );
  });

  it('tokenHash : select:false (jamais retourné par une requête par défaut)', () => {
    const path = OrganizationInvitationSchema.path('tokenHash');
    expect(
      (path as unknown as { options: { select?: boolean } }).options.select,
    ).toBe(false);
  });

  it('aucun index TTL (`expireAfterSeconds`) — les invitations expirées sont conservées', () => {
    const indexes = OrganizationInvitationSchema.indexes();
    for (const [, options] of indexes) {
      expect(
        (options as { expireAfterSeconds?: number }).expireAfterSeconds,
      ).toBeUndefined();
    }
  });

  it('déclare exactement les 3 index attendus (tokenHash unique, liste, pending unique partiel)', () => {
    const indexes = OrganizationInvitationSchema.indexes();
    expect(indexes).toHaveLength(3);

    const tokenHashIndex = indexes.find(
      ([key]) => (key as Record<string, number>).tokenHash === 1,
    );
    expect(tokenHashIndex).toBeDefined();
    expect((tokenHashIndex![1] as { unique?: boolean }).unique).toBe(true);

    const listIndex = indexes.find(
      ([key]) => (key as Record<string, number>).createdAt === -1,
    );
    expect(listIndex![0]).toEqual({
      organizationId: 1,
      status: 1,
      createdAt: -1,
    });

    const pendingIndex = indexes.find(
      ([key]) =>
        (key as Record<string, number>).organizationId === 1 &&
        (key as Record<string, number>).email === 1,
    );
    expect((pendingIndex![1] as { unique?: boolean }).unique).toBe(true);
    expect(
      (
        pendingIndex![1] as {
          partialFilterExpression?: Record<string, unknown>;
        }
      ).partialFilterExpression,
    ).toEqual({ status: 'pending' });
  });
});
