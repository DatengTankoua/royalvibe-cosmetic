/**
 * Phase 1-1B — rattachement organisationnel rétrocompatible
 * (`organizationId`) des 4 ressources métier : sections, products,
 * sales, auditlogs.
 *
 * Exécuté SANS connexion MongoDB : métadonnées de schéma
 * (chemin, options, `indexes()`) + instances locales via des registres
 * Mongoose en mémoire (`new Mongoose()`), donc aucune opération réseau,
 * aucun `syncIndexes()` ni `createIndexes()`.
 *
 * Pour chaque ressource, couverture des 10 points du cahier des charges :
 *   1. le chemin `organizationId` existe ;
 *   2. son type Mongoose est `ObjectId` ;
 *   3. sa référence est exactement `Organization` ;
 *   4. sa valeur par défaut est `null` ;
 *   5. il n'est pas obligatoire (ni immutable, ni index, ni select) ;
 *   6. une instance créée sans `organizationId` obtient `null` ;
 *   7. l'index tenant composite existe avec l'ordre ET les directions
 *      exacts (ordre vérifié SANS tri préalable des clés) ;
 *   8. cet index est non unique ;
 *   9. aucun index simple `{ organizationId: 1 }` n'existe ;
 *  10. aucun doublon d'index n'existe (tenant ou autre).
 */
import { Mongoose, Schema as MongooseSchema, Types } from 'mongoose';
import { SectionSchema } from '../sections/schemas/section.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { SaleSchema } from '../sales/schemas/sale.schema';
import { AuditAction, AuditLogSchema } from '../audit/schemas/audit-log.schema';

type IndexEntry = [Record<string, number>, Record<string, unknown>];

type TenantPath = {
  instance: string;
  options: Record<string, unknown>;
  default(value?: unknown): unknown;
};

type TenantSchema = {
  path(name: string): TenantPath | undefined;
  indexes(): IndexEntry[];
};

type TenantModel = new (doc?: Record<string, unknown>) => {
  organizationId: unknown;
};

type TenantSpec = {
  label: 'Section' | 'Product' | 'Sale' | 'AuditLog';
  schema: TenantSchema;
  /** Ordre ET directions exacts attendus de l'index tenant composite. */
  tenantIndexKeys: [string, number][];
  /** Document minimal (champs requis seulement) sans `organizationId`. */
  minimalDoc(): Record<string, unknown>;
};

let models: Record<TenantSpec['label'], TenantModel>;

beforeAll(() => {
  // Registres mémoire dédiés : aucune connexion MongoDB n'est ouverte.
  const registry = new Mongoose();
  const asModel = (
    name: TenantSpec['label'],
    schema: TenantSchema,
  ): TenantModel => registry.model(name, schema) as unknown as TenantModel;
  models = {
    Section: asModel('Section', SectionSchema as TenantSchema),
    Product: asModel('Product', ProductSchema as TenantSchema),
    Sale: asModel('Sale', SaleSchema as TenantSchema),
    AuditLog: asModel('AuditLog', AuditLogSchema as TenantSchema),
  };
});

const oid = () => new Types.ObjectId();

const SPECS: TenantSpec[] = [
  {
    label: 'Section',
    schema: SectionSchema as TenantSchema,
    tenantIndexKeys: [
      ['organizationId', 1],
      ['parentId', 1],
      ['deletedAt', 1],
    ],
    minimalDoc: () => ({ name: 'S' }),
  },
  {
    label: 'Product',
    schema: ProductSchema as TenantSchema,
    tenantIndexKeys: [
      ['organizationId', 1],
      ['sectionId', 1],
      ['deletedAt', 1],
    ],
    minimalDoc: () => ({
      sectionId: oid(),
      name: 'P',
      imageUrl: 'k',
      purchasePrice: 0,
      salePrice: 1,
      initialQuantity: 1,
      remainingQuantity: 1,
    }),
  },
  {
    label: 'Sale',
    schema: SaleSchema as TenantSchema,
    tenantIndexKeys: [
      ['organizationId', 1],
      ['productId', 1],
      ['createdAt', -1],
    ],
    minimalDoc: () => ({
      productId: oid(),
      quantity: 1,
      salePrice: 1,
      sellerId: oid(),
    }),
  },
  {
    label: 'AuditLog',
    schema: AuditLogSchema as TenantSchema,
    tenantIndexKeys: [
      ['organizationId', 1],
      ['productId', 1],
      ['action', 1],
      ['createdAt', -1],
    ],
    minimalDoc: () => ({
      productId: oid(),
      action: AuditAction.CREATED,
      actorId: oid(),
    }),
  },
];

const tenantIndexesOf = (schema: TenantSchema): IndexEntry[] =>
  schema.indexes().filter(([key]) => key.organizationId === 1);

for (const spec of SPECS) {
  describe(`${spec.label} — champ organizationId (phase 1-1B)`, () => {
    it('déclare `organizationId` (ObjectId, ref Organization, défaut null, optionnelle) et produit `null` par défaut sur une instance sans champ', () => {
      const p = spec.schema.path('organizationId');
      expect(p).toBeDefined();
      // (1) chemin présent ; (2) type Mongoose ObjectId — path ObjectId et
      //     type déclaré `MongooseSchema.Types.ObjectId` (déclaration
      //     prescrite phase 1-1B : `@nestjs/mongoose@11.0.4` résout une
      //     classe BSON en `@Prop({ type })` comme définition de classe
      //     imbriquée — donc `Mixed` — les chemins existants
      //     parentId/sectionId/productId/sellerId/actorId, en dette
      //     préexistante documentée, ne sont volontairement PAS couverts ici) ;
      // (3) référence exacte `Organization`.
      expect(p?.instance).toBe('ObjectId');
      expect(p?.options.type).toBe(MongooseSchema.Types.ObjectId);
      expect(p?.options.ref).toBe('Organization');
      // (4) défaut null ; (5) optionnel, pas d'immutable/index/select.
      expect(p?.default()).toBeNull();
      expect(p?.options.required).not.toBe(true);
      expect(p?.options.immutable).toBeUndefined();
      expect(p?.options.index).toBeUndefined();
      expect(p?.options.select).toBeUndefined();
      // Prédicteur fonctionnel : la valeur saisie est réellement castée en
      // `Types.ObjectId` (frontière d'isolation multi-tenant).
      const casted = new models[spec.label]({
        ...spec.minimalDoc(),
        organizationId: '68b329da98935c8688fd1234',
      }).organizationId;
      expect(casted?.constructor?.name).toBe('ObjectId');
      // (6) rétrocompatibilité : document créé SANS `organizationId` → null.
      const doc = new models[spec.label](spec.minimalDoc());
      expect(doc.organizationId).toBeNull();
    });

    it('déclare exactement l’index tenant composite (ordre et directions exacts, non unique), sans index simple ni doublon', () => {
      const indexes = spec.schema.indexes();
      // (7) un seul index incluant `organizationId`, avec l'ordre et la
      //     direction de chaque clé tels que déclarés (pas de tri
      //     préalable : l'ordre séquentiel est l'assertion).
      const tenant = tenantIndexesOf(spec.schema);
      expect(tenant).toHaveLength(1);
      const [key, options] = tenant[0];
      expect(Object.keys(key)).toHaveLength(spec.tenantIndexKeys.length);
      expect(
        Object.entries(key).map(([k, v]) => [k, v] as [string, number]),
      ).toEqual(spec.tenantIndexKeys);
      // (8) non unique.
      expect(options.unique).not.toBe(true);
      // (9) aucun index simple `{ organizationId: 1 }`.
      const singleField = indexes.filter(
        ([k]) => Object.keys(k).length === 1 && k.organizationId === 1,
      );
      expect(singleField).toHaveLength(0);
      // (10) aucun doublon d'index (empreintes dédupliquées).
      const fingerprints = indexes.map(([k]) =>
        JSON.stringify(
          Object.entries(k).sort(([a], [b]) => a.localeCompare(b)),
        ),
      );
      expect(fingerprints.find((f, i) => fingerprints.indexOf(f) !== i)).toBe(
        undefined,
      );
    });
  });
}
