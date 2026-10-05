import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { AuditAction } from '../audit/schemas/audit-log.schema';

/**
 * 1-15D — rattrapage EXPLICITE de l'historique des ventes dont le produit a
 * été supprimé définitivement AVANT 1-15D (aucun `lastKnown*` posé).
 *
 * Sources restantes après la purge : le journal d'audit du produit et les
 * noms enregistrés par ses autres ventes. Elles ne se valent pas
 * (`ProductsService`) :
 *
 * - CONFIRMENT une valeur réellement enregistrée : `created` (écrit après la
 *   création du produit : nom et prix d'achat), `deleted` (écrit après la
 *   mise à la corbeille, nom relu dans le document), et le `productName` d'une
 *   vente (lu dans la transaction de vente) ;
 * - ne prouvent qu'une TENTATIVE : les valeurs `to` de `name_changed`,
 *   `price_changed` et `section_changed`, journalisées AVANT
 *   l'enregistrement du produit, qui peut encore échouer ensuite (section
 *   cible absente, erreur d'écriture…).
 *
 * Règle : la dernière valeur confirmée est retenue, SAUF si une tentative de
 * valeur différente la suit ; le champ reste alors inconnu (impossible de
 * savoir si la tentative a abouti) et le cas est signalé. Les valeurs `from`
 * ne décident jamais : chacune est suivie de sa propre tentative.
 *
 * Les valeurs retenues vont dans `lastKnown*` avec `lastKnownSource:
 * 'audit'` ; `productName` n'est jamais écrit.
 *
 * - Simulation par défaut ; écriture seulement avec `apply`.
 * - Idempotent : seules les ventes sans `lastKnownSource` sont visées, et le
 *   filtre est répété dans l'écriture (aucun écrasement, même concurrent).
 * - Aucune valeur inventée : sans aucune valeur confirmée, la vente est
 *   laissée intacte et signalée comme irrécupérable.
 * - Aucune création de collection ni d'index (collections brutes).
 */

export interface SaleHistoryBackfillOptions {
  apply: boolean;
  organizationId?: string;
}

export interface SaleHistoryBackfillReport {
  mode: 'dry-run' | 'apply';
  organizationId: string | null;
  /** Ventes sans historique dont le produit n'existe plus. */
  candidates: number;
  /** Ventes pour lesquelles au moins un champ est confirmé. */
  recoverable: number;
  /** Ventes sans aucune valeur confirmée : laissées intactes. */
  unrecoverable: number;
  /** Ventes réellement modifiées (toujours 0 en simulation). */
  updated: number;
  unrecoverableSaleIds: string[];
  /** Nom non confirmé (laissé inconnu). */
  nameUnknownSaleIds: string[];
  /** Coût d'achat non confirmé (laissé inconnu : bénéfice « — »). */
  costUnknownSaleIds: string[];
}

/** Élément chronologique : trace d'audit, ou nom enregistré par une vente. */
export type HistoryTrace =
  | {
      kind: 'audit';
      action: AuditAction;
      details?: Record<string, unknown> | null;
    }
  | { kind: 'sale'; productName: string };

export interface LastKnownProduct {
  name?: string;
  unitCost?: number;
}

const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const validCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const toValue = (value: unknown): unknown =>
  value !== null && typeof value === 'object'
    ? (value as { to?: unknown }).to
    : undefined;

/** Dernière valeur confirmée, invalidée par une tentative différente. */
class ConfirmedField<T extends string | number> {
  private value: T | undefined;
  private uncertain = false;

  constructor(private readonly valid: (v: unknown) => v is T) {}

  confirm(candidate: unknown): void {
    if (!this.valid(candidate)) return;
    this.value = candidate;
    this.uncertain = false;
  }

  attempt(candidate: unknown): void {
    if (this.valid(candidate) && candidate !== this.value) {
      this.uncertain = true;
    }
  }

  result(): T | undefined {
    return this.uncertain ? undefined : this.value;
  }
}

/**
 * Dernier nom et dernier prix d'achat CONFIRMÉS, d'après des traces triées
 * chronologiquement (la plus récente en dernier). Voir l'en-tête du module.
 */
export function confirmedLastKnown(traces: HistoryTrace[]): LastKnownProduct {
  const name = new ConfirmedField<string>(validName);
  const cost = new ConfirmedField<number>(validCost);
  for (const trace of traces) {
    if (trace.kind === 'sale') {
      name.confirm(trace.productName.trim());
      continue;
    }
    const details = trace.details ?? {};
    switch (trace.action) {
      case AuditAction.CREATED:
        name.confirm(
          typeof details.name === 'string' ? details.name.trim() : undefined,
        );
        cost.confirm(details.purchasePrice);
        break;
      case AuditAction.DELETED:
        name.confirm(
          typeof details.name === 'string' ? details.name.trim() : undefined,
        );
        break;
      default: {
        // Toute autre trace portant une modification (`name_changed`,
        // `price_changed`, `section_changed` cumulant les changements) :
        // tentative seulement.
        const attempted = toValue(details.name);
        name.attempt(
          typeof attempted === 'string' ? attempted.trim() : attempted,
        );
        cost.attempt(toValue(details.purchasePrice));
        break;
      }
    }
  }
  const result: LastKnownProduct = {};
  const knownName = name.result();
  const knownCost = cost.result();
  if (knownName !== undefined) result.name = knownName;
  if (knownCost !== undefined) result.unitCost = knownCost;
  return result;
}

const TRACED_ACTIONS = [
  AuditAction.CREATED,
  AuditAction.NAME_CHANGED,
  AuditAction.PRICE_CHANGED,
  AuditAction.SECTION_CHANGED,
  AuditAction.DELETED,
];

interface OrphanGroup {
  _id: { organizationId: Types.ObjectId; productId: Types.ObjectId };
  saleIds: Types.ObjectId[];
}

interface Dated {
  at: number;
  /** À instant égal, la tentative passe APRÈS (choix prudent). */
  rank: number;
  trace: HistoryTrace;
}

export async function backfillSaleProductHistory(
  connection: Connection,
  options: SaleHistoryBackfillOptions,
): Promise<SaleHistoryBackfillReport> {
  const sales = connection.collection('sales');
  const audits = connection.collection('auditlogs');
  const scope = options.organizationId
    ? { organizationId: new Types.ObjectId(options.organizationId) }
    : { organizationId: { $ne: null } };

  // Ventes sans historique, groupées par produit, dont le produit n'existe
  // plus dans la MÊME organisation.
  const groups = (await sales
    .aggregate([
      { $match: { ...scope, lastKnownSource: { $exists: false } } },
      {
        $group: {
          _id: { organizationId: '$organizationId', productId: '$productId' },
          saleIds: { $push: '$_id' },
        },
      },
      {
        $lookup: {
          from: 'products',
          let: {
            productId: '$_id.productId',
            organizationId: '$_id.organizationId',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$_id', '$$productId'] },
                    { $eq: ['$organizationId', '$$organizationId'] },
                  ],
                },
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'product',
        },
      },
      { $match: { product: { $size: 0 } } },
      { $sort: { '_id.organizationId': 1, '_id.productId': 1 } },
    ])
    .toArray()) as OrphanGroup[];

  const report: SaleHistoryBackfillReport = {
    mode: options.apply ? 'apply' : 'dry-run',
    organizationId: options.organizationId ?? null,
    candidates: 0,
    recoverable: 0,
    unrecoverable: 0,
    updated: 0,
    unrecoverableSaleIds: [],
    nameUnknownSaleIds: [],
    costUnknownSaleIds: [],
  };

  for (const group of groups) {
    const ids = group.saleIds.map(String);
    report.candidates += ids.length;
    const product = {
      organizationId: group._id.organizationId,
      productId: group._id.productId,
    };
    const auditRows = await audits
      .find(
        { ...product, action: { $in: TRACED_ACTIONS } },
        { projection: { action: 1, details: 1, createdAt: 1 } },
      )
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const namedSales = await sales
      .find(
        { ...product, productName: { $type: 'string' } },
        { projection: { productName: 1, createdAt: 1 } },
      )
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const dated: Dated[] = [
      ...auditRows.map((row) => ({
        at: new Date(row.createdAt as Date).getTime(),
        rank: 1,
        trace: {
          kind: 'audit' as const,
          action: row.action as AuditAction,
          details: row.details as Record<string, unknown> | null,
        },
      })),
      ...namedSales.map((row) => ({
        at: new Date(row.createdAt as Date).getTime(),
        rank: 0,
        trace: { kind: 'sale' as const, productName: String(row.productName) },
      })),
    ];
    // Tri stable : l'ordre (createdAt, _id) de chaque source est conservé.
    dated.sort((a, b) => a.at - b.at || a.rank - b.rank);
    const known = confirmedLastKnown(dated.map((d) => d.trace));

    if (known.name === undefined) report.nameUnknownSaleIds.push(...ids);
    if (known.unitCost === undefined) report.costUnknownSaleIds.push(...ids);
    if (known.name === undefined && known.unitCost === undefined) {
      report.unrecoverable += ids.length;
      report.unrecoverableSaleIds.push(...ids);
      continue;
    }
    report.recoverable += ids.length;
    if (!options.apply) continue;
    const result = await sales.updateMany(
      { _id: { $in: group.saleIds }, lastKnownSource: { $exists: false } },
      {
        $set: {
          ...(known.name !== undefined
            ? { lastKnownProductName: known.name }
            : {}),
          ...(known.unitCost !== undefined
            ? { lastKnownUnitCost: known.unitCost }
            : {}),
          lastKnownSource: 'audit',
        },
      },
    );
    report.updated += result.modifiedCount;
  }
  return report;
}

/** Arguments du CLI : `[--apply] [--organization-id=<ObjectId>]`. */
export function parseBackfillArguments(
  argv: string[],
): SaleHistoryBackfillOptions | { error: string } {
  const options: SaleHistoryBackfillOptions = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg.startsWith('--organization-id=')) {
      const id = arg.slice('--organization-id='.length);
      if (!/^[0-9a-f]{24}$/i.test(id)) {
        return { error: 'identifiant d’organisation invalide' };
      }
      options.organizationId = id;
    } else {
      return { error: `argument inconnu : ${arg}` };
    }
  }
  return options;
}
