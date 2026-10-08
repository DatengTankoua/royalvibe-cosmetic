/**
 * Phase 1-1A — tests unitaires du schéma OrganizationMembership.
 * Exécutés SANS connexion MongoDB : validation locale via
 * `await doc.validate()` (l'API non-dépréciée de Mongoose 9) et
 * vérification de la déclaration d'index sur le schéma.
 */
import { Mongoose, Types } from 'mongoose';
import {
  OrganizationMembership,
  OrganizationMembershipSchema,
} from './schemas/membership.schema';

type MembershipInstance = {
  organizationId: Types.ObjectId | undefined;
  userId: Types.ObjectId | undefined;
  role: string | undefined;
  status: string | undefined;
  invitedById: Types.ObjectId | null;
  joinedAt: Date | undefined;
  permissions: string[];
  validate(): Promise<unknown>;
};

/**
 * Rejette uniquement quand un document invalide produit une
 * `ValidationError` Mongoose (valeur de rejection avec `name ===
 * 'ValidationError'`). Sans affaiblir : si le document valide à tort, la
 * promesse résout et le test échoue. `re` (optionnel) filtre le message.
 */
const expectInvalid = async (
  doc: MembershipInstance,
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
  if (re) {
    expect(err?.message).toMatch(re);
  }
};

const expectValid = async (doc: MembershipInstance): Promise<void> => {
  await expect(doc.validate()).resolves.toBeUndefined();
};

let mModel: new (doc?: Record<string, unknown>) => MembershipInstance;

beforeAll(() => {
  // Registre mémoire dédié : aucun modèle n'est touché hors de ce test,
  // et aucune connexion MongoDB n'est ouverte.
  const registry = new Mongoose();
  mModel = registry.model(
    OrganizationMembership.name,
    OrganizationMembershipSchema,
  );
});

describe('OrganizationMembershipSchema', () => {
  const oid = () => new Types.ObjectId();

  const member = (fields: Record<string, unknown> = {}) =>
    new mModel({ organizationId: oid(), userId: oid(), ...fields });

  it('applique les valeurs par défaut (seller, active, permissions vides, invitedById null, joinedAt Date)', () => {
    const m = new mModel({ organizationId: oid(), userId: oid() });
    expect(m.role).toBe('seller');
    expect(m.status).toBe('active');
    expect(m.permissions).toEqual([]);
    expect(m.invitedById).toBeNull();
    expect(m.joinedAt).toBeInstanceOf(Date);
  });

  it('déclare les timestamps', () => {
    expect(OrganizationMembershipSchema.options.timestamps).toBe(true);
  });

  it('exige organizationId et userId (références)', async () => {
    await expectInvalid(new mModel({ userId: oid() }), /organizationId/);
    await expectInvalid(new mModel({ organizationId: oid() }), /userId/);
  });

  it('valide les rôles et statuts', async () => {
    for (const role of ['owner', 'admin', 'seller']) {
      await expectValid(member({ role }));
    }
    await expectInvalid(member({ role: 'supplier' }));

    for (const status of ['active', 'suspended', 'revoked']) {
      await expectValid(member({ status }));
    }
    await expectInvalid(member({ status: 'deleted' }));
  });

  it('refuse une permission inconnue', async () => {
    await expectInvalid(
      member({ permissions: ['nope.permission'] }),
      /permissions/,
    );
    await expectValid(member({ permissions: ['analytics.read'] }));
  });

  it('refuse les permissions dupliquées', async () => {
    await expectInvalid(
      member({ permissions: ['analytics.read', 'analytics.read'] }),
      /permissions/,
    );
  });

  it('déclare exactement les trois index attendus', () => {
    const indexes = OrganizationMembershipSchema.indexes();
    const keyOf = (entry: [unknown, unknown]): string =>
      JSON.stringify(
        Object.entries(entry[0] as Record<string, number>)
          .sort(([a], [b]) => a.localeCompare(b))
          .reduce<Record<string, number>>((acc, [k, v]) => {
            acc[k] = v;
            return acc;
          }, {}),
      );
    expect(indexes).toHaveLength(3);
    expect(indexes.map(keyOf).sort()).toEqual(
      [
        { organizationId: 1, role: 1 },
        { organizationId: 1, userId: 1 },
        { status: 1, userId: 1 },
      ].map(JSON.stringify),
    );
    // L'index {organizationId, userId} est aussi UNIQUE (une membership par
    // personne par organisation) : options vérifiées par toMatchObject.
    const membershipIndex = indexes.find(
      ([key]) =>
        (key as Record<string, number>).organizationId === 1 &&
        (key as Record<string, number>).userId === 1,
    );
    expect(membershipIndex?.[1]).toMatchObject({ unique: true });
  });

  it('déclare l’index owner unique partiel avec les options exactes', () => {
    const ownerIndexes = OrganizationMembershipSchema.indexes().filter(
      ([key]) =>
        (key as Record<string, number>).organizationId === 1 &&
        (key as Record<string, number>).role === 1,
    );
    expect(ownerIndexes).toHaveLength(1);
    expect(ownerIndexes[0][1]).toEqual({
      unique: true,
      partialFilterExpression: { role: 'owner', status: 'active' },
    });
    // L’index partiel unique borne à un maximum l’owner actif ; il ne peut
    // PAS garantir la présence d’un owner (invariant applicatif, 1-6/1-7+).
    const uniqueOnOrgOnly = OrganizationMembershipSchema.indexes().find(
      ([key]) =>
        Object.keys(key as Record<string, number>).length === 1 &&
        (key as Record<string, number>).organizationId === 1,
    );
    expect(uniqueOnOrgOnly).toBeUndefined();
  });

  it('n’ajoute aucun champ active ni activeOrganizationId', () => {
    const paths = Object.keys(OrganizationMembershipSchema.paths);
    expect(paths).not.toContain('active');
    expect(paths).not.toContain('activeOrganizationId');
  });
});
