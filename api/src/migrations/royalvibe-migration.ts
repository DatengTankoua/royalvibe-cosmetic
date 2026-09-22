import type { Connection, Model } from 'mongoose';
import { Types } from 'mongoose';
import {
  MembershipStatus,
  OrganizationCurrency,
  OrganizationRole,
  OrganizationStatus,
} from '../organizations/permissions';
import type { DelegablePermission } from '../organizations/permissions';

/**
 * Moteur de migration mono-tenant → organisation « RoyalVibe ».
 *
 * Contrat : reçoit EXPLICITEMENT une `Connection` déjà ouverte et un mode ; ne
 * jamais ouvrir de connexion ni lire `MONGODB_URI`. `dryRun` : vérifications +
 * plan, zéro écriture. `apply` : une seule transaction ; en cas d'erreur,
 * abort intégral, session fermée.
 */

export type MigrationMode = 'dryRun' | 'apply';
export type MigrationStatus = 'success' | 'blocked' | 'rolledBack';
export type ResourceKey = 'sections' | 'products' | 'sales' | 'audits';

export const ROYALVIBE_OWNER_EMAIL = 'franck@royalvibe.com';

/** Identité cible figée — le préflight exige une compatibilité stricte. */
export const ROYALVIBE_ORGANIZATION = Object.freeze({
  name: 'RoyalVibe',
  slug: 'royalvibe',
  currency: OrganizationCurrency.XAF,
  brandColor: '#b8960c',
  status: OrganizationStatus.ACTIVE,
});

export interface MigrationCounts {
  sections: number;
  products: number;
  sales: number;
  audits: number;
}

export interface MigrationResult {
  mode: MigrationMode;
  status: MigrationStatus;
  /** Organisation détectée (réutilisée) ou prévue (à créer). */
  organization: {
    id: string | null;
    detected: boolean;
    name: string;
    slug: string;
    currency: string;
    brandColor: string;
  };
  /** Propriétaire détecté ; `null` s'il est absent (blocage). */
  owner: { email: string; userId: string } | null;
  /** Nombres d'utilisateurs par rôle historique. */
  roleCounts: Record<string, number>;
  /** Documents à rattacher (`organizationId` nulle ou absente). */
  plan: MigrationCounts;
  /** Documents effectivement modifiés (zéro en dry-run/blocage). */
  modified: MigrationCounts;
  memberships: { existing: number; created: number; total: number };
  warnings: string[];
  blocks: string[];
}

// Le driver MongoDB n'est pas une dépendance directe du workspace : on déduit
// le type exact de la session depuis `Connection`.
type MongooseSession = Awaited<ReturnType<Connection['startSession']>>;
// Document `lean()` : le `_id` est un `Types.ObjectId` BSON réel.
type LeanDoc = Record<string, unknown> & { _id: Types.ObjectId };
interface LeanOrg {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  currency: string;
  brandColor: string;
  status: string;
}
type ResourceModel = Model<Record<string, unknown>>;

const ZERO: MigrationCounts = { sections: 0, products: 0, sales: 0, audits: 0 };

/** `{ organizationId: null }` matche aussi les docs où le champ est absent. */
const NULL_ORGANIZATION: Record<string, unknown> = { organizationId: null };

/** Références BSON auditées par ressource (dette `Mixed` héritée). */
const REF_FIELDS: Record<ResourceKey, readonly string[]> = {
  sections: ['parentId'],
  products: ['sectionId'],
  sales: ['productId', 'sellerId'],
  audits: ['productId', 'actorId'],
};

function isObjectId(value: unknown): value is Types.ObjectId {
  return value instanceof Types.ObjectId;
}

/** Id hexadécimal d'un ObjectId ; `null` si non-BSON. */
function toHex(value: unknown): string | null {
  return value instanceof Types.ObjectId ? value.toHexString() : null;
}

function refState(value: unknown): 'objectId' | 'nullable' | 'invalid' {
  if (value === null || value === undefined) return 'nullable';
  return isObjectId(value) ? 'objectId' : 'invalid';
}

function orgLabel(org: LeanOrg): string {
  return `«${org.name}» (${org.slug})`;
}

/** Rôle historique d'un user par l'hex de son `_id` ; '' si absent. */
function userHistoricalRole(users: LeanDoc[], uidHex: string): string {
  const u = users.find((x) => x._id.toHexString() === uidHex);
  return u ? String(u.role) : '';
}

interface Preflight {
  blocks: string[];
  warnings: string[];
  owner: LeanDoc | null;
  roleCounts: Record<string, number>;
  org: LeanOrg | null;
  compatibleOrgId: Types.ObjectId | null;
  plans: MigrationCounts;
  totals: MigrationCounts;
}

async function leanAll(
  m: ResourceModel,
  session?: MongooseSession,
): Promise<LeanDoc[]> {
  const q = m.find({});
  if (session) q.session(session);
  return (await q.lean().exec()) as unknown as LeanDoc[];
}

async function preflight(
  models: {
    sections: ResourceModel;
    products: ResourceModel;
    sales: ResourceModel;
    audits: ResourceModel;
    organizations: ResourceModel;
    memberships: ResourceModel;
    users: ResourceModel;
  },
  session?: MongooseSession,
): Promise<Preflight> {
  const blocks: string[] = [];
  const warnings: string[] = [];

  const users = await leanAll(models.users, session);
  const organizations = (await leanAll(
    models.organizations,
    session,
  )) as unknown as LeanOrg[];
  const memberships = await leanAll(models.memberships, session);

  // 1./2. propriétaire unique et rôle mappable.
  const ownerUsers = users.filter((u) => u.email === ROYALVIBE_OWNER_EMAIL);
  const owner = ownerUsers[0] ?? null;
  if (ownerUsers.length === 0) {
    blocks.push(`propriétaire « ${ROYALVIBE_OWNER_EMAIL} » absent`);
  } else if (ownerUsers.length > 1) {
    blocks.push(
      `plusieurs comptes « ${ROYALVIBE_OWNER_EMAIL} » (${ownerUsers.length})`,
    );
  }

  // 3. toutes les valeurs de rôle historiques sont connues (`admin`/`seller`),
  //    sans escalade possible au-delà d'admin pour les non-propriétaires.
  const roleCounts: Record<string, number> = {};
  for (const u of users) {
    roleCounts[String(u.role)] = (roleCounts[String(u.role)] ?? 0) + 1;
  }
  const knownRoles = new Set(['admin', 'seller']);
  const unknownRoles = [
    ...new Set(
      users.map((u) => String(u.role)).filter((r) => !knownRoles.has(r)),
    ),
  ];
  if (unknownRoles.length > 0) {
    blocks.push(`rôles historiques inconnus : ${unknownRoles.join(', ')}`);
  }

  // 4. organisation cible : absente ou strictement compatible.
  const target = organizations.find(
    (o) => o.slug === ROYALVIBE_ORGANIZATION.slug,
  );
  let compatibleOrgId: Types.ObjectId | null = null;
  if (target) {
    const compatible =
      target.name === ROYALVIBE_ORGANIZATION.name &&
      target.slug === ROYALVIBE_ORGANIZATION.slug &&
      target.currency === String(ROYALVIBE_ORGANIZATION.currency) &&
      target.brandColor === ROYALVIBE_ORGANIZATION.brandColor &&
      target.status === String(OrganizationStatus.ACTIVE);
    if (compatible) {
      compatibleOrgId = target._id;
    } else {
      blocks.push(
        `organisation cible « ${ROYALVIBE_ORGANIZATION.slug} » incompatible (name/slug/currency/brandColor/status)`,
      );
    }
  }

  // 5./6. ressources : plan, totaux, organisation étrangère détentrice,
  // 9. références historiques strictement BSON.
  const plans: MigrationCounts = { ...ZERO };
  const totals: MigrationCounts = { ...ZERO };
  const holdingOrgIds = new Set<string>();
  const invalidRefCounts: string[] = [];
  const resourceModels: Record<ResourceKey, ResourceModel[]> = {
    sections: [models.sections],
    products: [models.products],
    sales: [models.sales],
    audits: [models.audits],
  };
  for (const [key, [model]] of Object.entries(resourceModels) as [
    ResourceKey,
    ResourceModel[],
  ][]) {
    const docs = await leanAll(model, session);
    totals[key] = docs.length;
    plans[key] = docs.filter((d) => d.organizationId == null).length;
    for (const d of docs) {
      if (
        isObjectId(d.organizationId) &&
        d.organizationId.toHexString() !==
          (compatibleOrgId?.toHexString() ?? null)
      ) {
        holdingOrgIds.add(d.organizationId.toHexString());
      }
    }
    const invalid = docs.filter((d) =>
      REF_FIELDS[key].some((f) => refState(d[f]) === 'invalid'),
    ).length;
    if (invalid > 0) {
      invalidRefCounts.push(
        `${key} : ${invalid} doc(s) avec ${REF_FIELDS[key].join('/')}`,
      );
    }
  }
  if (invalidRefCounts.length > 0) {
    blocks.push(
      `références historiques invalides (ni ObjectId ni null) — rien n'est converti : ${invalidRefCounts.join(' ; ')}`,
    );
  }
  const knownOrgIds = new Set<string>(
    organizations.map((o) => o._id.toHexString()),
  );
  const foreignDetentors = [...holdingOrgIds].filter((id) =>
    knownOrgIds.has(id),
  );
  if (foreignDetentors.length > 0) {
    blocks.push(
      `organisation(s) étrangère(s) détenant des données : ${foreignDetentors
        .map((id) => {
          const o = organizations.find((x) => x._id.toHexString() === id);
          return o ? orgLabel(o) : id;
        })
        .join(', ')}`,
    );
  }
  const dangling = [...holdingOrgIds].filter((id) => !knownOrgIds.has(id));
  if (dangling.length > 0) {
    blocks.push(
      `organizationId en suspens (organisation inexistante) : ${dangling.join(', ')}`,
    );
  }

  // 7./8. memberships existantes de l'organisation cible : chacune doit être
  // active, pointée vers un user existant, non-owner, de rôle compatible ; la
  // membership du propriétaire est active et non-owner (la promotion est
  // appliquée, jamais une retrogradation ou une réactivation silencieuse).
  // Comparaisons par hex : une ref lean() non-BSON est un défaut, pas un id.
  const ownerHex = owner ? owner._id.toHexString() : null;
  const userHexIds = new Set(
    users.map((u) => toHex(u._id)).filter((v): v is string => v !== null),
  );
  const existingOnTarget = compatibleOrgId
    ? memberships.filter((m) => {
        const v = toHex(m.organizationId);
        return v !== null && v === compatibleOrgId.toHexString();
      })
    : [];
  // L'index unique (organizationId, userId) est déclaré mais pas garanti créé
  // sur Atlas : les doublons d'un même user sur l'org cible sont donc
  // détectés explicitement ici (blocage avant toute écriture).
  const userMembershipCount = new Map<string, number>();
  for (const m of existingOnTarget) {
    const uid = toHex(m.userId);
    if (uid !== null) {
      userMembershipCount.set(uid, (userMembershipCount.get(uid) ?? 0) + 1);
    }
  }
  for (const [uid, n] of userMembershipCount) {
    if (n > 1) {
      blocks.push(
        `doublon de membership (organizationId, userId) sur l'organisation cible : ${n} documents pour l'utilisateur ${uid}`,
      );
    }
  }
  const expectedRole: Record<string, OrganizationRole> = {
    admin: OrganizationRole.ADMIN,
    seller: OrganizationRole.SELLER,
  };
  for (const m of existingOnTarget) {
    const label = `membership ${m._id.toHexString()}`;
    const uid = toHex(m.userId);
    if (uid === null) {
      blocks.push(`${label} : référence d'utilisateur invalide (ni ObjectId)`);
      continue;
    }
    if (!userHexIds.has(uid)) {
      blocks.push(`${label} : utilisateur inexistant (reference orpheline)`);
      continue;
    }
    if (String(m.status) !== String(MembershipStatus.ACTIVE)) {
      blocks.push(`${label} : statut non actif « ${String(m.status)} »`);
      continue;
    }
    const role = String(m.role);
    if (role === String(OrganizationRole.OWNER)) {
      if (uid !== ownerHex) {
        blocks.push(`${label} : owner actif qui n'est pas le propriétaire`);
      }
      continue;
    }
    const isOwner = ownerHex !== null && uid === ownerHex;
    const histRole = userHistoricalRole(users, uid);
    if (isOwner) {
      // Propriétaire : admin/seller actif avant promotion attendus ; le cas
      // owner actif est déjà traité par la branche ci-dessus.
      const ok =
        role === String(OrganizationRole.ADMIN) ||
        role === String(OrganizationRole.SELLER);
      if (!ok) {
        blocks.push(
          `${label} : rôle « ${role} » — propriétaire sans rôle historique actif`,
        );
      }
    } else {
      const expected = expectedRole[histRole];
      if (expected === undefined || role !== String(expected)) {
        blocks.push(
          `${label} : rôle « ${role} » incompatible avec le rôle historique « ${histRole} »`,
        );
      }
    }
  }

  // 5 (bis). organisations sans aucune donnée historique : inoffensives.
  const dataOrgIds = new Set<string>([
    ...holdingOrgIds,
    ...(compatibleOrgId ? [compatibleOrgId.toHexString()] : []),
  ]);
  for (const o of organizations) {
    if (!dataOrgIds.has(o._id.toHexString())) {
      warnings.push(`organisation externe sans données : ${orgLabel(o)}`);
    }
  }

  return {
    blocks,
    warnings,
    owner,
    roleCounts,
    org: compatibleOrgId ? (target as LeanOrg) : null,
    compatibleOrgId,
    plans,
    totals,
  };
}

/**
 * Exécute la migration. Ne lève pas sur blocage (`status: 'blocked'` avec les
 * causes) ; un `apply` en erreur retourne `status: 'rolledBack'` (transaction
 * abortée, session fermée).
 */
export async function runRoyalVibeTenantMigration(
  connection: Connection,
  mode: MigrationMode,
): Promise<MigrationResult> {
  // Modèles résolus par leur nom de registration : la `Connection` est celle
  // des services Nest, déjà pourvue des modèles. La garde rend l'absence
  // explicite au lieu d'un `undefined.find`.
  const getModel = (name: string): ResourceModel => {
    const m = connection.models[name];
    if (!m) {
      throw new Error(`modèle non enregistré sur la connection : ${name}`);
    }
    return m as ResourceModel;
  };

  const users = getModel('User');
  const organizations = getModel('Organization');
  const memberships = getModel('OrganizationMembership');
  const sections = getModel('Section');
  const products = getModel('Product');
  const sales = getModel('Sale');
  const audits = getModel('AuditLog');

  const pf = await preflight({
    sections,
    products,
    sales,
    audits,
    organizations,
    memberships,
    users,
  });

  const result: MigrationResult = {
    mode,
    status: 'success',
    organization: {
      id: pf.org ? pf.org._id.toHexString() : null,
      detected: pf.org != null,
      name: ROYALVIBE_ORGANIZATION.name,
      slug: ROYALVIBE_ORGANIZATION.slug,
      currency: ROYALVIBE_ORGANIZATION.currency,
      brandColor: ROYALVIBE_ORGANIZATION.brandColor,
    },
    owner: pf.owner
      ? { email: ROYALVIBE_OWNER_EMAIL, userId: pf.owner._id.toHexString() }
      : null,
    roleCounts: pf.roleCounts,
    plan: pf.plans,
    modified: { ...ZERO },
    memberships: { existing: 0, created: 0, total: 0 },
    warnings: pf.warnings,
    blocks: pf.blocks,
  };

  if (pf.blocks.length > 0) {
    result.status = 'blocked';
    return result;
  }
  if (mode === 'dryRun') {
    // Zéro écriture garantie : le plan et les causes de blocage suffisent.
    return result;
  }

  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      // Re-vérification en transaction : une divergence concurrente doit
      // aborter toute l'écriture.
      const re = await preflight(
        {
          sections,
          products,
          sales,
          audits,
          organizations,
          memberships,
          users,
        },
        session,
      );
      if (re.blocks.length > 0) {
        throw new Error(`préflight en transaction : ${re.blocks.join(' | ')}`);
      }

      let orgId: Types.ObjectId;
      if (re.org) {
        orgId = re.org._id;
      } else {
        const created = await organizations.create(
          [
            {
              name: ROYALVIBE_ORGANIZATION.name,
              slug: ROYALVIBE_ORGANIZATION.slug,
              currency: ROYALVIBE_ORGANIZATION.currency,
              brandColor: ROYALVIBE_ORGANIZATION.brandColor,
              status: ROYALVIBE_ORGANIZATION.status,
            },
          ],
          { session },
        );
        orgId = created[0]._id as Types.ObjectId;
      }
      result.organization.id = orgId.toHexString();
      result.organization.detected = re.org != null;

      const txUsers = (await users
        .find({})
        .session(session)
        .lean()
        .exec()) as unknown as LeanDoc[];
      const txMemberships = (await memberships
        .find({ organizationId: orgId })
        .session(session)
        .lean()
        .exec()) as unknown as LeanDoc[];
      const ownerHexTx = re.owner?._id.toHexString() ?? null;
      const existingUserIds = new Set<string>(
        txMemberships
          .map((m) => toHex(m.userId))
          .filter((v): v is string => v !== null),
      );
      result.memberships.existing = existingUserIds.size;
      const missing = txUsers.filter(
        (u) => !existingUserIds.has(u._id.toHexString()),
      );
      const roleOf = (u: LeanDoc): OrganizationRole =>
        ownerHexTx !== null && u._id.toHexString() === ownerHexTx
          ? OrganizationRole.OWNER
          : (String(u.role) as OrganizationRole);
      if (missing.length > 0) {
        const seeds: {
          organizationId: Types.ObjectId;
          userId: Types.ObjectId;
          role: OrganizationRole;
          status: MembershipStatus;
          permissions: DelegablePermission[];
        }[] = missing.map((u) => ({
          organizationId: orgId,
          userId: u._id,
          role: roleOf(u),
          status: MembershipStatus.ACTIVE,
          permissions: [],
        }));
        // `ordered: true` est exigé par `Model.create` sessionnel multi-docs.
        await memberships.create(seeds, { session, ordered: true });
      }
      const ownerMembership =
        ownerHexTx !== null
          ? txMemberships.find((m) => toHex(m.userId) === ownerHexTx)
          : undefined;
      const needsOwnerPromotion =
        ownerHexTx === null ||
        ownerMembership === undefined ||
        String(ownerMembership.role) !== String(OrganizationRole.OWNER) ||
        String(ownerMembership.status) !== String(MembershipStatus.ACTIVE);
      if (needsOwnerPromotion && ownerHexTx !== null) {
        await memberships.updateOne(
          { organizationId: orgId, userId: new Types.ObjectId(ownerHexTx) },
          {
            $set: {
              role: OrganizationRole.OWNER,
              status: MembershipStatus.ACTIVE,
            },
          },
          { session },
        );
      }

      // Seuls les docs `organizationId` null/absent : aucun écrasement.
      const attach = async (m: ResourceModel): Promise<number> => {
        const r = await m.updateMany(
          NULL_ORGANIZATION,
          { $set: { organizationId: orgId } },
          { session },
        );
        return r.modifiedCount;
      };
      result.modified = {
        sections: await attach(sections),
        products: await attach(products),
        sales: await attach(sales),
        audits: await attach(audits),
      };

      // Invariants STRICTS avant commit : toute divergence → throw → abort.
      // `countDocuments` sans filtre compte aussi les docs nuls, l'égalité
      // `rattaché = total` est donc stricte ; les deux comptes résiduels
      // (nul, étranger) doivent être 0.
      const count = (m: ResourceModel, f: Record<string, unknown>) =>
        m.countDocuments(f).session(session).exec();
      const activeOwners = await count(memberships, {
        organizationId: orgId,
        role: OrganizationRole.OWNER,
        status: MembershipStatus.ACTIVE,
      });
      if (activeOwners !== 1) {
        throw new Error(`invariant owner : ${activeOwners} owner(s) actif(s)`);
      }
      const activeMembers = await count(memberships, {
        organizationId: orgId,
        status: MembershipStatus.ACTIVE,
      });
      if (activeMembers !== txUsers.length) {
        throw new Error(
          `invariant memberships : ${activeMembers} active(s), attendu ${txUsers.length}`,
        );
      }
      const resourceByKey: Record<ResourceKey, ResourceModel> = {
        sections,
        products,
        sales,
        audits,
      };
      for (const k of ['sections', 'products', 'sales', 'audits'] as const) {
        const m = resourceByKey[k];
        const total = re.totals[k];
        const nullDocs = await count(m, NULL_ORGANIZATION);
        const attached = await count(m, { organizationId: orgId });
        // `$nin: [null, orgId]` : existe et différent (nul et absent exclus).
        const foreign = await count(m, {
          organizationId: { $nin: [null, orgId] },
        });
        if (nullDocs !== 0 || attached !== total || foreign !== 0) {
          throw new Error(
            `invariant rattachement ${k} : ${attached}/${total} rattachés, ${nullDocs} sans organisation, ${foreign} étrangers`,
          );
        }
      }
      result.memberships.created = missing.length;
      result.memberships.total = activeMembers;
    });
  } catch (err) {
    // `withTransaction` a déjà aborté ; on consigne la cause et on ferme.
    result.status = 'rolledBack';
    result.modified = { ...ZERO };
    result.memberships = { existing: 0, created: 0, total: 0 };
    result.blocks.push(
      `abandon : ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await session.endSession();
  }
  return result;
}
