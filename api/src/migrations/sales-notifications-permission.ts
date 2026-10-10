/**
 * 1-19A — Inventaire (et retrait, pour un RETOUR ARRIÈRE seulement) de la
 * permission délégable `sales.notifications`.
 *
 * Une API antérieure à 1-19A refuse cette valeur à la validation : toute
 * écriture d'un document qui la porte échouerait (modification d'un membre,
 * acceptation d'une invitation qui la copie). Documents concernés — les
 * SEULS à stocker des permissions délégables :
 * - `organizationmemberships.permissions` (tout rôle et tout statut : un
 *   administrateur ou un propriétaire a pu la recevoir explicitement avant un
 *   changement de rôle, un membre suspendu peut être réactivé) ;
 * - `organizationinvitations.permissions` (en attente ou expirées ; une
 *   invitation en attente la recopierait dans la membership).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:sales-notifications-permission
 *   MONGODB_URI=... pnpm --filter api migrate:sales-notifications-permission --strip
 *   MONGODB_URI=... pnpm --filter api migrate:sales-notifications-permission --strip --apply
 *
 * - Sans option : INVENTAIRE en lecture seule (comptages par collection,
 *   rôle ou statut).
 * - `--strip` : aperçu du retrait, aucune écriture.
 * - `--strip --apply` : retrait (`$pull`) dans les deux collections.
 *   Idempotent. À n'exécuter QU'AVANT de redéployer une API antérieure ;
 *   les membres concernés ne reçoivent plus les notifications de ventes
 *   (comportement de l'ancienne version).
 * - Ne journalise jamais l'URI, une adresse ni un identifiant.
 */
import { createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import { INVITATIONS_COLLECTION } from '../organizations/invitation-account-index';

export const SALES_NOTIFICATIONS_PERMISSION = 'sales.notifications';
export const MEMBERSHIPS_COLLECTION = 'organizationmemberships';

export interface SalesNotificationsInventory {
  memberships: {
    total: number;
    byRole: Record<string, number>;
    byStatus: Record<string, number>;
  };
  invitations: { total: number; byStatus: Record<string, number> };
}

/** Forme minimale des documents porteurs de permissions. */
interface PermissionHolder {
  permissions: string[];
}

const carrying = { permissions: SALES_NOTIFICATIONS_PERMISSION };

async function countBy(
  connection: Connection,
  collection: string,
  field: string,
): Promise<Record<string, number>> {
  const rows = await connection
    .collection(collection)
    .aggregate<{ _id: string | null; n: number }>([
      { $match: carrying },
      { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    ])
    .toArray();
  return Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
}

const sum = (r: Record<string, number>) =>
  Object.values(r).reduce((a, b) => a + b, 0);

/** Inventaire en lecture seule. */
export async function inventorySalesNotifications(
  connection: Connection,
): Promise<SalesNotificationsInventory> {
  const [byRole, byStatus, invitationsByStatus] = await Promise.all([
    countBy(connection, MEMBERSHIPS_COLLECTION, 'role'),
    countBy(connection, MEMBERSHIPS_COLLECTION, 'status'),
    countBy(connection, INVITATIONS_COLLECTION, 'status'),
  ]);
  return {
    memberships: { total: sum(byRole), byRole, byStatus },
    invitations: {
      total: sum(invitationsByStatus),
      byStatus: invitationsByStatus,
    },
  };
}

/** Retrait (retour arrière) ; renvoie le nombre de documents modifiés. */
export async function stripSalesNotifications(
  connection: Connection,
): Promise<{ memberships: number; invitations: number }> {
  const pull = { $pull: { permissions: SALES_NOTIFICATIONS_PERMISSION } };
  const [memberships, invitations] = await Promise.all([
    connection
      .collection<PermissionHolder>(MEMBERSHIPS_COLLECTION)
      .updateMany(carrying, pull),
    connection
      .collection<PermissionHolder>(INVITATIONS_COLLECTION)
      .updateMany(carrying, pull),
  ]);
  return {
    memberships: memberships.modifiedCount,
    invitations: invitations.modifiedCount,
  };
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const strip = args.includes('--strip');
  const apply = args.includes('--apply');
  if (
    args.some((a) => a !== '--strip' && a !== '--apply') ||
    (apply && !strip)
  ) {
    console.error('Usage : [--strip [--apply]]');
    process.exitCode = 2;
    return;
  }
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    const inventory = await inventorySalesNotifications(connection);
    console.log(
      JSON.stringify({
        permission: SALES_NOTIFICATIONS_PERMISSION,
        ...inventory,
      }),
    );
    if (!strip) return;
    if (!apply) {
      console.log('Aperçu du retrait : aucune écriture (ajouter --apply).');
      return;
    }
    const removed = await stripSalesNotifications(connection);
    console.log(
      `Retrait : ${removed.memberships} membership(s), ${removed.invitations} invitation(s).`,
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Inventaire sales.notifications échoué :',
      error instanceof Error ? error.name : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
