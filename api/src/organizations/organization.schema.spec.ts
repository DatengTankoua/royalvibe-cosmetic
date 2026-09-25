/**
 * Phase 1-1A — tests unitaires du schéma Organization et de la matrice de
 * permissions. Exécutés SANS connexion MongoDB : validation locale via
 * `await doc.validate()` (API non-dépréciée, rejets asynchrones) ;
 * `validateSync()` est déprécié en Mongoose 9, retourne
 * `ValidationError | undefined` et n'est pas une API Promise ; et
 * vérification de la déclaration d'index (aucune unicité réelle sans base).
 */
import { Mongoose } from 'mongoose';
import {
  Organization,
  OrganizationSchema,
} from './schemas/organization.schema';
import {
  ALL_DELEGABLE_PERMISSIONS,
  DEFAULT_PERMISSIONS_BY_ROLE,
  DELEGABLE_PERMISSIONS,
  OWNER_ONLY_OPERATIONS,
  OrganizationCurrency,
  OrganizationRole,
  OrganizationStatus,
} from './permissions';

type OrgInstance = {
  name: string | undefined;
  slug: string | undefined;
  currency: string | undefined;
  status: string | undefined;
  brandColor: string | undefined;
  logoKey: string | null;
  validate(): Promise<unknown>;
};

let orgModel: new (doc?: Record<string, unknown>) => OrgInstance;

beforeAll(() => {
  // Registre mémoire dédié : aucun modèle global n'est touché et aucune
  // connexion MongoDB n'est ouverte.
  const registry = new Mongoose();
  orgModel = registry.model(Organization.name, OrganizationSchema);
});

const org = (fields: Record<string, unknown> = {}) =>
  new orgModel({ name: 'RoyalVibe', slug: 'royalvibe', ...fields });

/**
 * Un document invalide doit REJETER `validate()` ; la rejection est
 * vérifiée comme une `ValidationError` Mongoose (sans affaiblir : si le
 * document valide à tort, la promesse résout et le test échoue).
 */
const expectInvalid = async (doc: OrgInstance): Promise<void> => {
  let err: { name?: string } | undefined;
  let rejected = false;
  try {
    await doc.validate();
  } catch (reason) {
    err = reason as { name?: string };
    rejected = true;
  }
  expect(rejected).toBe(true);
  expect(err?.name).toBe('ValidationError');
};

/** Un document valide doit FULFILLER `validate()` (valeur résolue `undefined`). */
const expectValid = async (doc: OrgInstance): Promise<void> => {
  await expect(doc.validate()).resolves.toBeUndefined();
};

const slugIndexesOf = (schema: typeof OrganizationSchema): unknown[][] =>
  schema
    .indexes()
    .filter(([key]) => 'slug' in (key as Record<string, unknown>))
    .map(([key, options]) => [key, options] as unknown[]);

describe('OrganizationSchema', () => {
  it('applique les valeurs par défaut sûres (XAF, active, #FF6A00, logoKey null)', () => {
    const o = org();
    expect(o.currency).toBe('XAF');
    expect(o.currency).not.toBe('XOF');
    expect(o.status).toBe('active');
    expect(o.brandColor).toBe('#FF6A00');
    // 1-8A : l'ancien défaut RoyalVibe n'est jamais réintroduit.
    expect(o.brandColor).not.toBe('#b8960c');
    expect(o.logoKey).toBeNull();
  });

  it('déclare les timestamps', () => {
    expect(OrganizationSchema.options.timestamps).toBe(true);
  });

  it('rejette un nom vide ou ne contenant que des espaces', async () => {
    await expectInvalid(org({ name: '   ' }));
    await expectInvalid(org({ name: '' }));
  });

  it('normalise le slug en minuscules et impose le format recommandé', async () => {
    await expectValid(org());
    expect(new orgModel({ name: 'RoyalVibe', slug: 'RoyalVibe' }).slug).toBe(
      'royalvibe',
    );

    await expectInvalid(org({ slug: 'royal vibe' }));
    await expectInvalid(org({ slug: 'royal_vibe' }));
    await expectInvalid(org({ slug: 'a'.repeat(81) }));
    await expectValid(org({ slug: 'a'.repeat(80) }));
  });

  it('rejette une couleur non hexadécimale et accepte #RRGGBB', async () => {
    await expectInvalid(org({ brandColor: 'red' }));
    await expectValid(org({ brandColor: '#AABBCC' }));
    expect(org({ brandColor: '#AABBCC' }).brandColor).toBe('#AABBCC');
  });

  it('rejette une devise inconnue (notamment XOF) et accepte XAF/EUR', async () => {
    await expectInvalid(org({ currency: 'XOF' }));
    expect(Object.values(OrganizationCurrency)).not.toContain('XOF');
    await expectValid(org({ currency: 'EUR' }));
  });

  it("rejette un statut d'organisation inconnu", async () => {
    expect(Object.values(OrganizationStatus)).toEqual(['active', 'suspended']);
    await expectValid(org({ status: 'suspended' }));
    await expectInvalid(org({ status: 'closed' }));
  });

  it('déclare exactement UN index unique sur slug (déclaration unique `unique: true`, sans double déclaration `schema.index`)', () => {
    const slugIndexes = slugIndexesOf(OrganizationSchema);
    expect(slugIndexes).toHaveLength(1);
    expect(slugIndexes[0][0]).toEqual({ slug: 1 });
    expect((slugIndexes[0][1] as { unique?: boolean }).unique).toBe(true);
  });
});

describe('permissions (phase 1-1A)', () => {
  const setOf = (list: readonly unknown[]): Set<string> =>
    new Set(list.map((p) => p as string));

  it('owner : toutes les permissions délégables par défaut', () => {
    expect(setOf(DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.OWNER])).toEqual(
      setOf(ALL_DELEGABLE_PERMISSIONS),
    );
  });

  it('admin : toutes les permissions délégables par défaut', () => {
    expect(setOf(DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.ADMIN])).toEqual(
      setOf(ALL_DELEGABLE_PERMISSIONS),
    );
  });

  it('seller : uniquement sales.record et sales.view_own par défaut', () => {
    const seller = DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.SELLER];
    expect([...seller].sort()).toEqual(['sales.record', 'sales.view_own']);
  });

  it('liste délégable : 12 permissions, aucune opération owner-only', () => {
    expect(ALL_DELEGABLE_PERMISSIONS).toHaveLength(12);
    for (const op of OWNER_ONLY_OPERATIONS) {
      expect(ALL_DELEGABLE_PERMISSIONS).not.toContain(
        op as (typeof ALL_DELEGABLE_PERMISSIONS)[number],
      );
    }
  });

  it('expose des constantes immuables (frozen)', () => {
    expect(Object.isFrozen(DELEGABLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(ALL_DELEGABLE_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(OWNER_ONLY_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PERMISSIONS_BY_ROLE)).toBe(true);
    const roleLists = Object.values(DEFAULT_PERMISSIONS_BY_ROLE);
    expect(roleLists).toHaveLength(3);
    for (const list of roleLists) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('conserve les valeurs fonctionnelles inchangées', () => {
    expect([...DELEGABLE_PERMISSIONS].sort()).toEqual([
      'analytics.read',
      'audit.read',
      'branding.manage',
      'catalog.manage',
      'members.invite',
      'members.manage',
      'products.manage',
      'sales.record',
      'sales.view_all',
      'sales.view_own',
      'stock.adjust',
      'trash.manage',
    ]);
    // Pas de seconde source divergente : identité de référence.
    expect(Object.is(ALL_DELEGABLE_PERMISSIONS, DELEGABLE_PERMISSIONS)).toBe(
      true,
    );
    expect(setOf(DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.OWNER])).toEqual(
      setOf(ALL_DELEGABLE_PERMISSIONS),
    );
    expect(setOf(DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.ADMIN])).toEqual(
      setOf(ALL_DELEGABLE_PERMISSIONS),
    );
    expect(setOf(DEFAULT_PERMISSIONS_BY_ROLE[OrganizationRole.SELLER])).toEqual(
      new Set(['sales.record', 'sales.view_own']),
    );
    expect(ALL_DELEGABLE_PERMISSIONS).toHaveLength(12);
    expect([...OWNER_ONLY_OPERATIONS].sort()).toEqual([
      'billing.identity',
      'organization.delete',
      'owner.attribution',
      'ownership.transfer',
    ]);
  });
});
