import 'reflect-metadata';
import { Model, Types } from 'mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule } from '@nestjs/mongoose';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import {
  E2E_DB_NAME,
  startEphemeralMongo,
  stopEphemeralMongoSafe,
  validatedEphemeralUri,
} from './e2e/ephemeral-mongodb';
import { UserSchema } from './../src/users/schemas/user.schema';
import { OrganizationSchema } from './../src/organizations/schemas/organization.schema';
import { OrganizationMembershipSchema } from './../src/organizations/schemas/membership.schema';
import { SectionSchema } from './../src/sections/schemas/section.schema';
import { ProductSchema } from './../src/products/schemas/product.schema';
import { SaleSchema } from './../src/sales/schemas/sale.schema';
import {
  AuditAction,
  AuditLogSchema,
} from './../src/audit/schemas/audit-log.schema';
import {
  ROYALVIBE_OWNER_EMAIL,
  runRoyalVibeTenantMigration,
} from './../src/migrations/royalvibe-migration';

/**
 * E2E — moteur idempotent de migration RoyalVibe sur le repl set éphémère.
 *
 * 14 tests : T1 dry-run ; T2 apply ; T3 idempotence ; T4 owner absent ;
 * T5 rôle inconnu ; T6 org étrangère ; T7 ref BSON invalide ; T8 rollback
 * post-écritures (ordre `updateMany` → `FAIL`) ; T9a (4 cas `it.each`)
 * memberships incompatibles ; T9b propriétaire owner actif (idempotent) ;
 * T9c doublon `(organizationId, userId)` (index unique non garanti).
 *
 * Le moteur reçoit la `Connection` du conteneur de test : il ne lit ni
 * `MONGODB_URI` ni secret (garde `validatedEphemeralUri` — jamais le port
 * 27017). Les documents « historiques » contournant la validation Mongoose
 * (rôle inconnu, `organizationId` étrangère, référence string) simulent des
 * données réelles héritées, exactement ce que la préflight doit détecter
 * puis bloquer sans rien convertir ni écrire. Aucun hook de test dans le
 * moteur : T8 espionne `countDocuments`/`updateMany` des modèles via
 * l'instance de requête (`.op`/`.options.session`).
 */

const ADMIN_EMAIL = 'a1@royalvibe.com';
const SELLER_EMAIL = 'b2@royalvibe.com';
const SELLER2_EMAIL = 'c3@royalvibe.com';

/** Champs métier snapshotés (hors `organizationId`/`_id`/`timestamps`). */
const BUSINESS_FIELDS = {
  sections: ['name', 'description', 'parentId', 'deletedAt'],
  products: [
    'sectionId',
    'name',
    'imageUrl',
    'purchasePrice',
    'salePrice',
    'initialQuantity',
    'remainingQuantity',
    'deletedAt',
  ],
  sales: [
    'productId',
    'productName',
    'quantity',
    'salePrice',
    'sellerId',
    'buyerName',
    'buyerContact',
  ],
  audits: ['productId', 'action', 'actorId', 'details'],
} as const;

type ResourceKey = keyof typeof BUSINESS_FIELDS;

function pick(
  doc: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = doc[f] ?? null;
  return out;
}

describe('Migration RoyalVibe (moteur idempotent, repl set éphémère)', () => {
  let moduleFixture: TestingModule;
  let connection: Connection;
  // Modèles lus via le CONTENEUR NEST (même connection que le moteur),
  // jamais la connection Mongoose globale. `Model<unknown>` : on utilise
  // `.create`/`.collection`/`.find` de manière générique (pas de type doc).
  let User: Model<unknown>;
  let Organization: Model<unknown>;
  let Membership: Model<unknown>;
  let Section: Model<unknown>;
  let Product: Model<unknown>;
  let Sale: Model<unknown>;
  let AuditLog: Model<unknown>;

  const seedUser = (email: string, role?: string) =>
    User.create({
      name: email.slice(0, 4),
      email,
      password: 'pw-x1',
      ...(role === undefined ? {} : { role }),
    });

  const createSection = (extra: Record<string, unknown> = {}) =>
    Section.create({
      name: `S${Math.random().toString(36).slice(2, 8)}`,
      description: '',
      ...extra,
    });

  const createProduct = (sectionId: Types.ObjectId) =>
    Product.create({
      sectionId,
      name: `P${Math.random().toString(36).slice(2, 8)}`,
      imageUrl: 'https://e2e.local/i.png',
      purchasePrice: 10,
      salePrice: 40,
      initialQuantity: 7,
      remainingQuantity: 4,
    });

  const createSale = (productId: Types.ObjectId, sellerId: Types.ObjectId) =>
    Sale.create({
      productId,
      productName: 'snapshot',
      quantity: 2,
      salePrice: 40,
      sellerId,
      buyerName: 'Client',
    });

  const createAudit = (
    productId: Types.ObjectId,
    actorId: Types.ObjectId,
    action: AuditAction = AuditAction.CREATED,
  ) => AuditLog.create({ productId, action, actorId, details: {} });

  /** RoyalVibe préexistante compatible : la migration doit la RÉUTILISER. */
  const seedRoyalVibeOrg = async (): Promise<unknown> =>
    Organization.create({
      name: 'RoyalVibe',
      slug: 'royalvibe',
      currency: 'XAF',
      brandColor: '#b8960c',
      status: 'active',
    });

  /** Membership existante sur l'org cible (écriture brute = état hérité). */
  const rawMembership = (
    organizationId: unknown,
    userId: unknown,
    role: string,
    status: string,
  ) =>
    Membership.collection.insertOne({
      organizationId,
      userId,
      role,
      status,
      permissions: [],
      joinedAt: new Date(),
    });

  /** Données mono-tenant de référence : 4 users / 3 sections / 2 products / 2 sales / 2 audits. */
  async function seedBaseline() {
    const franck = await seedUser(ROYALVIBE_OWNER_EMAIL, 'admin');
    const admin = await seedUser(ADMIN_EMAIL, 'admin');
    const seller = await seedUser(SELLER_EMAIL, 'seller');
    const seller2 = await seedUser(SELLER2_EMAIL, 'seller');
    const s1 = await createSection();
    const s2 = await createSection({ parentId: s1._id, deletedAt: new Date() });
    const s3 = await createSection({ deletedAt: new Date() });
    const p1 = await createProduct(s1._id);
    const p2 = await createProduct(s2._id);
    await createSale(p1._id, seller._id);
    await createSale(p2._id, admin._id);
    await createAudit(p1._id, admin._id);
    await createAudit(p2._id, franck._id, AuditAction.PRICE_CHANGED);
    return { franck, admin, seller, seller2, s1, s2, s3, p1, p2 };
  }

  /** Snapshot brut de la base (JSON stable : ObjectId → `{$oid}`, Date → `{$date}`). */
  const snapshotRaw = async (): Promise<string> => {
    const rows: Record<string, unknown> = {};
    rows.users = await User.collection.find({}).sort({ _id: 1 }).toArray();
    rows.organizations = await Organization.collection
      .find({})
      .sort({ _id: 1 })
      .toArray();
    rows.memberships = await Membership.collection
      .find({})
      .sort({ _id: 1 })
      .toArray();
    rows.sections = await Section.collection
      .find({})
      .sort({ _id: 1 })
      .toArray();
    rows.products = await Product.collection
      .find({})
      .sort({ _id: 1 })
      .toArray();
    rows.sales = await Sale.collection.find({}).sort({ _id: 1 }).toArray();
    rows.audits = await AuditLog.collection.find({}).sort({ _id: 1 }).toArray();
    return JSON.stringify(rows);
  };

  /** Champs métier des 4 ressources uniquement (hors `organizationId`). */
  const snapshotBusiness = async (): Promise<string> => {
    const out: Record<string, unknown> = {};
    const map: Record<ResourceKey, Model<unknown>> = {
      sections: Section,
      products: Product,
      sales: Sale,
      audits: AuditLog,
    };
    for (const k of ['sections', 'products', 'sales', 'audits'] as const) {
      const docs = await map[k]
        .find({})
        .sort({ _id: 1 })
        .lean({ virtuals: false })
        .exec();
      out[k] = docs.map((d) =>
        pick(d as Record<string, unknown>, BUSINESS_FIELDS[k]),
      );
    }
    return JSON.stringify(out);
  };

  beforeAll(async () => {
    const replSet = await startEphemeralMongo();
    try {
      const uri = validatedEphemeralUri(replSet);
      expect(new URL(uri).pathname).toBe(`/${E2E_DB_NAME}`);
      moduleFixture = await Test.createTestingModule({
        imports: [
          // `ConfigModule` volontairement absent : le moteur reçoit la
          // `Connection` injectée, il ne lit ni `.env` ni `MONGODB_URI`.
          MongooseModule.forRootAsync({
            useFactory: () => ({ uri, autoIndex: true }),
          }),
          MongooseModule.forFeature([
            { name: 'User', schema: UserSchema },
            { name: 'Organization', schema: OrganizationSchema },
            {
              name: 'OrganizationMembership',
              schema: OrganizationMembershipSchema,
            },
            { name: 'Section', schema: SectionSchema },
            { name: 'Product', schema: ProductSchema },
            { name: 'Sale', schema: SaleSchema },
            { name: 'AuditLog', schema: AuditLogSchema },
          ]),
        ],
      }).compile();
      connection = moduleFixture.get<Connection>(getConnectionToken());
      User = moduleFixture.get<Model<unknown>>(getModelToken('User'));
      Organization = moduleFixture.get<Model<unknown>>(
        getModelToken('Organization'),
      );
      Membership = moduleFixture.get<Model<unknown>>(
        getModelToken('OrganizationMembership'),
      );
      Section = moduleFixture.get<Model<unknown>>(getModelToken('Section'));
      Product = moduleFixture.get<Model<unknown>>(getModelToken('Product'));
      Sale = moduleFixture.get<Model<unknown>>(getModelToken('Sale'));
      AuditLog = moduleFixture.get<Model<unknown>>(getModelToken('AuditLog'));
    } catch (err) {
      if (moduleFixture) {
        await moduleFixture.close().catch(() => undefined);
      }
      await stopEphemeralMongoSafe();
      throw err;
    }
  }, 180_000);

  afterAll(async () => {
    if (moduleFixture) await moduleFixture.close().catch(() => undefined);
    await stopEphemeralMongoSafe();
  }, 60_000);

  beforeEach(async () => {
    // `deleteMany` brut (hors validation Mongoose) : nettoie tout, y compris
    // les documents corrompus volontaires.
    await Promise.all(
      [
        User.collection,
        Organization.collection,
        Membership.collection,
        Section.collection,
        Product.collection,
        Sale.collection,
        AuditLog.collection,
      ].map((c) => c.deleteMany({})),
    );
  });

  it('1. dry-run : plan et vérifications complets, zéro écriture, base strictement identique', async () => {
    const { franck } = await seedBaseline();
    const before = await snapshotRaw();
    const r = await runRoyalVibeTenantMigration(connection, 'dryRun');
    expect(r.mode).toBe('dryRun');
    expect(r.status).toBe('success');
    expect(r.blocks).toEqual([]);
    expect(r.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(r.plan).toEqual({
      sections: 3,
      products: 2,
      sales: 2,
      audits: 2,
    });
    expect(r.organization.detected).toBe(false);
    expect(r.organization.id).toBeNull();
    expect(r.organization.name).toBe('RoyalVibe');
    expect(r.organization.slug).toBe('royalvibe');
    expect(r.organization.currency).toBe('XAF');
    expect(r.organization.brandColor).toBe('#b8960c');
    expect(r.owner).toEqual({
      email: ROYALVIBE_OWNER_EMAIL,
      userId: franck._id.toHexString(),
    });
    expect(r.roleCounts).toEqual({ admin: 2, seller: 2 });
    // Zéro INSERT/UPDATE/UPSERT/DELETE : base strictement identique.
    expect(await snapshotRaw()).toBe(before);
    expect(await Organization.collection.countDocuments({})).toBe(0);
  });

  it('2. apply réussi : identité exacte, memberships correctes, rattachement des 4 ressources (corbeille incluse)', async () => {
    const { franck, admin, seller, seller2, p1 } = await seedBaseline();
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('success');
    expect(r.owner?.userId).toBe(franck._id.toHexString());
    expect(r.modified).toEqual({
      sections: 3,
      products: 2,
      sales: 2,
      audits: 2,
    });
    expect(r.memberships).toEqual({ existing: 0, created: 4, total: 4 });

    const orgs = await Organization.find({}).exec();
    expect(orgs).toHaveLength(1);
    const org = orgs[0].toObject({ virtuals: false }) as Record<
      string,
      unknown
    >;
    expect(org).toMatchObject({
      name: 'RoyalVibe',
      slug: 'royalvibe',
      currency: 'XAF',
      brandColor: '#b8960c',
      status: 'active',
    });
    expect(r.organization.id).toBe((org._id as Types.ObjectId).toHexString());

    const ms = (await Membership.find({})
      .lean({ virtuals: false })
      .exec()) as unknown as Record<
      string,
      { userId?: unknown; role?: unknown; status?: unknown }
    >[];
    const byUser = (id: Types.ObjectId) =>
      ms.find(
        (m) => (m.userId as Types.ObjectId)?.toHexString() === id.toHexString(),
      );
    expect(byUser(franck._id)?.role).toBe('owner');
    expect(byUser(franck._id)?.status).toBe('active');
    expect(byUser(admin._id)?.role).toBe('admin');
    expect(byUser(seller._id)?.role).toBe('seller');
    expect(byUser(seller2._id)?.role).toBe('seller');
    expect(
      await Membership.countDocuments({ role: 'owner', status: 'active' }),
    ).toBe(1);

    // Rattachement : plus aucun doc sans organizationId, les corbeillées
    // incluses.
    expect(
      await Section.countDocuments({ organizationId: { $eq: null } }),
    ).toBe(0);
    expect(
      await Product.countDocuments({ organizationId: { $eq: null } }),
    ).toBe(0);
    expect(await Sale.countDocuments({ organizationId: { $eq: null } })).toBe(
      0,
    );
    expect(
      await AuditLog.countDocuments({ organizationId: { $eq: null } }),
    ).toBe(0);
    expect(await Section.countDocuments({ organizationId: org._id })).toBe(3);
    expect(await Product.countDocuments({ organizationId: org._id })).toBe(2);
    expect(await Sale.countDocuments({ organizationId: org._id })).toBe(2);
    expect(await AuditLog.countDocuments({ organizationId: org._id })).toBe(2);
    // Corbeille incluse : la section corbeillée (deletedAt ≠ null) a bien un
    // `organizationId` (rattachée comme le reste).
    expect(
      await Section.countDocuments({
        organizationId: org._id,
        deletedAt: { $ne: null },
      }),
    ).toBe(2);
    // Donnée métier intacte (prix/quantités du P1) : seul organizationId a
    // changé.
    const p = await Product.findById(p1._id).exec();
    expect(
      (p?.toObject({ virtuals: false }) as Record<string, unknown>)
        .purchasePrice,
    ).toBe(10);
  });

  it('3. idempotence : une seconde exécution réussie ne change rien et reste unique', async () => {
    await seedBaseline();
    const first = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(first.status).toBe('success');
    const second = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(second.status).toBe('success');
    expect(second.organization.id).toBe(first.organization.id);
    expect(second.organization.detected).toBe(true);
    expect(second.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(second.memberships).toEqual({ existing: 4, created: 0, total: 4 });
    // Pas de suppression préalable : même organisation, nulle de plus.
    expect(await Organization.countDocuments()).toBe(1);
    expect(await Membership.countDocuments()).toBe(4);
    expect(
      await Membership.countDocuments({ role: 'owner', status: 'active' }),
    ).toBe(1);
  });

  it('4. propriétaire absent : blocage explicite et zéro écriture', async () => {
    await seedUser(ADMIN_EMAIL, 'admin');
    await seedUser(SELLER_EMAIL, 'seller');
    const before = await snapshotRaw();
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('blocked');
    expect(r.owner).toBeNull();
    expect(r.blocks).toEqual(
      expect.arrayContaining([expect.stringContaining(ROYALVIBE_OWNER_EMAIL)]),
    );
    expect(r.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(await Organization.collection.countDocuments({})).toBe(0);
    expect(await Membership.collection.countDocuments({})).toBe(0);
    expect(await snapshotRaw()).toBe(before);
  });

  it('5. rôle historique inconnu : blocage et zéro écriture', async () => {
    await seedBaseline();
    // Écriture brute (collection) : contournement volontaire de la validation
    // Mongoose pour simuler un rôle historique inconnu déjà présent.
    await User.collection.insertOne({
      name: 'X',
      email: 'x4@royalvibe.com',
      password: 'pw-x1',
      role: 'superadmin',
    });
    const before = await snapshotRaw();
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('blocked');
    expect(r.blocks).toEqual(
      expect.arrayContaining([expect.stringContaining('superadmin')]),
    );
    expect(r.plan).toEqual({
      sections: 3,
      products: 2,
      sales: 2,
      audits: 2,
    });
    expect(await Organization.collection.countDocuments({})).toBe(0);
    expect(await Membership.collection.countDocuments({})).toBe(0);
    expect(await snapshotRaw()).toBe(before);
    // Le rôle inconnu n'a PAS été converti / normalisé.
    const docs = await User.find({ email: 'x4@royalvibe.com' }).exec();
    expect(
      (docs[0].toObject({ virtuals: false }) as Record<string, unknown>).role,
    ).toBe('superadmin');
  });

  it('6. organizationId étrangère déjà rattachée : blocage et zéro écriture', async () => {
    await seedBaseline();
    const foreign = await Organization.create({
      name: 'AutreOrg',
      slug: 'autre',
    });
    // Tout le catalogue appartient déjà à l'org étrangère (données héritées,
    // contournement volontaire de la validation Mongoose).
    for (const m of [Section, Product, Sale, AuditLog]) {
      await m.updateMany({}, { $set: { organizationId: foreign._id } });
    }
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('blocked');
    expect(r.blocks).toEqual(
      expect.arrayContaining([expect.stringContaining('AutreOrg')]),
    );
    // Le plan reflète que rien n'est rattachable : tout est déjà chez AutreOrg.
    expect(r.plan).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(await Organization.collection.countDocuments({})).toBe(1);
    expect(await Membership.collection.countDocuments({})).toBe(0);
    // Aucune ressource n'a été rattachée à royalvibe.
    expect(
      await Section.collection.countDocuments({ organizationId: foreign._id }),
    ).toBe(3);
    expect(
      await Product.collection.countDocuments({ organizationId: foreign._id }),
    ).toBe(2);
    expect(
      await Sale.collection.countDocuments({ organizationId: foreign._id }),
    ).toBe(2);
    expect(
      await AuditLog.collection.countDocuments({ organizationId: foreign._id }),
    ).toBe(2);
  });

  it('7. référence BSON de type string : blocage et zéro écriture (rien n\u2019est converti)', async () => {
    await seedBaseline();
    const hex = new Types.ObjectId().toHexString();
    // Données héritées corrompues : `sectionId` stocké en string (dette
    // `Mixed`) : écriture brute (collection) pour que la string soit
    // réellement persistée — Mongoose ne re-caste plus en lecture.
    await Product.collection.updateMany({}, { $set: { sectionId: hex } });
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('blocked');
    expect(r.blocks.some((b) => b.toLowerCase().includes('référence'))).toBe(
      true,
    );
    // Le message nomme la ressource et le champ incriminé.
    expect(r.blocks.some((b) => b.includes('products'))).toBe(true);
    expect(r.blocks.some((b) => b.includes('sectionId'))).toBe(true);
    expect(r.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(await Organization.collection.countDocuments({})).toBe(0);
    expect(await Membership.collection.countDocuments({})).toBe(0);
    // Ni conversion, ni rattachement.
    const corrupted = (await Product.find({})
      .lean({ virtuals: false })
      .exec()) as unknown as Record<string, unknown>[];
    for (const d of corrupted) {
      expect(d.sectionId).toBe(hex);
      expect(d.organizationId ?? null).toBeNull();
    }
  });

  it('8. panne APRÈS toutes les écritures : rollback total (org, memberships, rattachements annulés)', async () => {
    const { p1 } = await seedBaseline();
    const rawBefore = await snapshotRaw();
    const businessBefore = await snapshotBusiness();
    // Panne injectée SUR la dernière opération de vérification (le
    // `countDocuments` de l'invariant « exactement 1 owner actif »).
    // Les 4 `updateMany` de rattachement sont logés pour PRouver qu'ils
    // ont précèdé l'échec (aucun hook de test dans le moteur).
    const order: string[] = [];
    const models = [
      Section,
      Product,
      Sale,
      AuditLog,
      Organization,
      Membership,
    ] as const;
    const originals = {
      count: models.map((m) => m.countDocuments.bind(m)),
      update: models.map((m) => m.updateMany.bind(m)),
    };
    // `updateMany` reçoit la session en argument d'options (positionnée à la
    // construction) ; `countDocuments` la reçoit par chaînage `.session()`
    // APRÈS la construction — la décision d'échec est donc reportée au
    // `exec()` de la requête, où la session est garantie (aucun hook de test).
    models.forEach((m, i) => {
      const origUpdate = originals.update[i];
      m.updateMany = ((
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        const q = origUpdate(filter, update, options) as unknown as {
          op: string;
          options: { session?: unknown };
        };
        if (q.op === 'updateMany' && q.options.session) {
          order.push(`updateMany:${i}`);
        }
        return q;
      }) as unknown as typeof m.updateMany;

      const origCount = originals.count[i];
      m.countDocuments = ((filter?: Record<string, unknown>) => {
        const q = origCount(filter ?? {}) as unknown as {
          op: string;
          options: { session?: unknown };
          exec: () => Promise<unknown>;
          [k: string]: unknown;
        };
        const exec = q.exec.bind(q);
        q.exec = () => {
          if (q.options.session) {
            const isOwnerCheck =
              !!filter && filter.role === 'owner' && filter.status === 'active';
            if (isOwnerCheck) {
              order.push('FAIL:ownerCheck');
              return Promise.reject(
                new Error('simulated final invariant failure'),
              );
            }
            order.push(`count:${i}`);
          }
          return exec();
        };
        return q;
      }) as unknown as typeof m.countDocuments;
    });
    let r;
    try {
      r = await runRoyalVibeTenantMigration(connection, 'apply');
    } finally {
      models.forEach((m, i) => {
        m.updateMany = originals.update[i];
        m.countDocuments = originals.count[i];
      });
    }
    expect(r.status).toBe('rolledBack');
    expect(r.blocks).toEqual(
      expect.arrayContaining([expect.stringContaining('simulated')]),
    );
    expect(r.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(r.memberships).toEqual({ existing: 0, created: 0, total: 0 });
    // Preuve d'ORDRE : les quatre `updateMany` de rattachement (les 4
    // premières écritures sessionnelles, `updateMany:k`) ont bien été exécutés
    // avant l'opération qui a échoué (le check owner, `FAIL:ownerCheck`).
    const writeIdx = order.filter((e) => e.startsWith('updateMany:'));
    const failIdx = order.indexOf('FAIL:ownerCheck');
    expect(failIdx).toBeGreaterThan(-1);
    expect(writeIdx).toEqual([
      'updateMany:0',
      'updateMany:1',
      'updateMany:2',
      'updateMany:3',
    ]);
    expect(Math.max(...writeIdx.map((e) => order.indexOf(e)))).toBeLessThan(
      failIdx,
    );
    // ROLLBACK total prouvé sur le repl set : la base est strictement revenue
    // à son état pré-application (comptes ET contenu).
    expect(await snapshotRaw()).toBe(rawBefore);
    expect(await snapshotBusiness()).toBe(businessBefore);
    expect(await Organization.collection.countDocuments({})).toBe(0);
    expect(await Membership.collection.countDocuments({})).toBe(0);
    for (const m of [Section, Product, Sale, AuditLog]) {
      expect(
        await m.collection.countDocuments({
          organizationId: { $ne: null },
        }),
      ).toBe(0);
    }
    // Données métier intactes (spot-check P1) ; `organizationId` annulé.
    const p = await Product.findById(p1._id).exec();
    expect(
      (p?.toObject({ virtuals: false }) as Record<string, unknown>)
        .purchasePrice,
    ).toBe(10);
    expect(
      (p?.toObject({ virtuals: false }) as Record<string, unknown>)
        .organizationId,
    ).toBeNull();
  });

  const membershipCases: [
    string,
    {
      role: string;
      status: string;
      userRef: 'seller' | 'ghost';
      blockIncludes: string;
    },
  ][] = [
    // L'admin pour un seller est bien « incompatible » (et non la branche
    // owner, qui nommerait un autre propriétaire).
    [
      'rôle incompatible',
      {
        role: 'admin',
        status: 'active',
        userRef: 'seller',
        blockIncludes: 'incompatible',
      },
    ],
    [
      'suspendue',
      {
        role: 'seller',
        status: 'suspended',
        userRef: 'seller',
        blockIncludes: 'suspend',
      },
    ],
    [
      'révoquée',
      {
        role: 'seller',
        status: 'revoked',
        userRef: 'seller',
        blockIncludes: 'revoke',
      },
    ],
    [
      'utilisateur inexistant',
      {
        role: 'seller',
        status: 'active',
        userRef: 'ghost',
        blockIncludes: 'utilisateur inexistant',
      },
    ],
  ];
  it.each(membershipCases)(
    '9a. membership pré-existante %s : blocage, zéro écriture, pré-existante inchangée',
    async (_label, cfg) => {
      const b = await seedBaseline();
      const org = await seedRoyalVibeOrg();
      const orgId = (org as Record<string, unknown>)._id as Types.ObjectId;
      const userId =
        cfg.userRef === 'seller' ? b.seller._id : new Types.ObjectId();
      await rawMembership(orgId, userId, cfg.role, cfg.status);
      const before = await snapshotRaw();
      const r = await runRoyalVibeTenantMigration(connection, 'apply');
      expect(r.status).toBe('blocked');
      expect(r.blocks).toEqual(
        expect.arrayContaining([expect.stringContaining(cfg.blockIncludes)]),
      );
      expect(r.modified).toEqual({
        sections: 0,
        products: 0,
        sales: 0,
        audits: 0,
      });
      expect(await Organization.collection.countDocuments({})).toBe(1);
      expect(await Membership.collection.countDocuments({})).toBe(1);
      expect(await snapshotRaw()).toBe(before);
    },
  );
  it('9b. propriétaire owner actif : réexécution idempotente acceptée', async () => {
    const b = await seedBaseline();
    const org = await seedRoyalVibeOrg();
    const orgId = (org as Record<string, unknown>)._id as Types.ObjectId;
    await rawMembership(orgId, b.franck._id, 'owner', 'active');
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('success');
    expect(r.organization.detected).toBe(true);
    expect(r.organization.id).toBe(orgId.toHexString());
    // Première apply : les 4 ressources (encore non rattachées) SONT
    // rattachées ; franck possède déjà sa membership owner → 3 créées.
    expect(r.modified).toEqual({
      sections: 3,
      products: 2,
      sales: 2,
      audits: 2,
    });
    expect(r.memberships).toEqual({ existing: 1, created: 3, total: 4 });
    expect(await Membership.countDocuments({})).toBe(4);
    expect(
      await Membership.countDocuments({ role: 'owner', status: 'active' }),
    ).toBe(1);
  });
  it('9c. doublon de membership (organizationId, userId) : blocage avant toute écriture', async () => {
    const b = await seedBaseline();
    const org = await seedRoyalVibeOrg();
    const orgId = (org as Record<string, unknown>)._id as Types.ObjectId;
    // `autoIndex` a matérialisé l'index unique (organizationId, userId) dans la
    // base éphémère. Pour exercer la DÉTECTION EN APPLICATION du moteur, on
    // simule l'état Atlas « index non créé » : le doublon historique doit y
    // être possible — on retire donc cet index (le moteur 1-2A ne dépend de
    // l'index : la garantie est appliquée en application, jamais au DB).
    const indexes = await Membership.collection.indexes();
    const dupIndex = indexes.find(
      (x) => x.name.includes('organizationId') && x.name.includes('userId'),
    );
    if (dupIndex) {
      await Membership.collection.dropIndex(dupIndex.name);
    }
    // Deux documents identiques pour le même user (état hérité possible).
    await rawMembership(orgId, b.seller._id, 'seller', 'active');
    await rawMembership(orgId, b.seller._id, 'seller', 'active');
    const before = await snapshotRaw();
    const r = await runRoyalVibeTenantMigration(connection, 'apply');
    expect(r.status).toBe('blocked');
    expect(r.blocks).toEqual(
      expect.arrayContaining([
        expect.stringContaining('doublon de membership'),
        expect.stringContaining(b.seller._id.toHexString()),
      ]),
    );
    expect(r.modified).toEqual({
      sections: 0,
      products: 0,
      sales: 0,
      audits: 0,
    });
    expect(await Organization.collection.countDocuments({})).toBe(1);
    expect(await Membership.collection.countDocuments({})).toBe(2);
    expect(await snapshotRaw()).toBe(before);
  });
});
