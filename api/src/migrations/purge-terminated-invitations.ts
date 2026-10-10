/**
 * 1-19A — Nettoyage HISTORIQUE des invitations terminées.
 *
 * Depuis 1-19A, une invitation acceptée ou révoquée est supprimée au moment
 * même de l'acceptation ou de la révocation. Les documents `accepted` et
 * `revoked` antérieurs restent dans `organizationinvitations` : ce CLI les
 * supprime, sans corbeille.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api migrate:purge-terminated-invitations
 *   MONGODB_URI=... pnpm --filter api migrate:purge-terminated-invitations --apply
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/purge-terminated-invitations.js [--apply]
 *
 * - Sans `--apply` : APERÇU seul (nombre de documents par statut), aucune
 *   écriture.
 * - `--apply` : suppression des seuls statuts `accepted` et `revoked`.
 *   Idempotent : relancé, il ne trouve plus rien (0 supprimé).
 * - Jamais touchées : invitations `pending` (encore utilisables) et
 *   `expired` (traitement inchangé dans ce lot).
 * - Ce qui reste prouvé ailleurs : la membership (organisation, rôle,
 *   invitant `invitedById`, `joinedAt`) et la preuve légale d'acceptation
 *   (`legal_acceptances`), indépendantes de l'invitation. Aucun jeton n'est
 *   conservé.
 * - Ne journalise JAMAIS l'URI, une adresse ni un identifiant : comptages
 *   seulement.
 */
import { createConnection } from 'mongoose';
import type { Connection } from 'mongoose';
import { InvitationStatus } from '../organizations/permissions';
import { INVITATIONS_COLLECTION } from '../organizations/invitation-account-index';

export const TERMINATED_INVITATION_STATUSES: readonly InvitationStatus[] =
  Object.freeze([InvitationStatus.ACCEPTED, InvitationStatus.REVOKED]);

export interface TerminatedInvitationsPreview {
  accepted: number;
  revoked: number;
  total: number;
}

const terminatedFilter = () => ({
  status: { $in: [...TERMINATED_INVITATION_STATUSES] },
});

/** Aperçu (lecture seule) : documents concernés par statut. */
export async function previewTerminatedInvitations(
  connection: Connection,
): Promise<TerminatedInvitationsPreview> {
  const collection = connection.collection(INVITATIONS_COLLECTION);
  const [accepted, revoked] = await Promise.all([
    collection.countDocuments({ status: InvitationStatus.ACCEPTED }),
    collection.countDocuments({ status: InvitationStatus.REVOKED }),
  ]);
  return { accepted, revoked, total: accepted + revoked };
}

/** Suppression idempotente ; renvoie le nombre de documents supprimés. */
export async function purgeTerminatedInvitations(
  connection: Connection,
): Promise<number> {
  const result = await connection
    .collection(INVITATIONS_COLLECTION)
    .deleteMany(terminatedFilter());
  return result.deletedCount;
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const unknown = process.argv
    .slice(2)
    .filter((a) => a !== '--' && a !== '--apply');
  if (unknown.length > 0) {
    console.error('Argument inconnu. Usage : [--apply]');
    process.exitCode = 2;
    return;
  }
  const apply = process.argv.includes('--apply');
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    const preview = await previewTerminatedInvitations(connection);
    console.log(
      `organizationinvitations : ${preview.accepted} acceptée(s), ${preview.revoked} révoquée(s) à supprimer (total ${preview.total}).`,
    );
    if (!apply) {
      console.log('Aperçu seul : aucune écriture (ajouter --apply).');
      return;
    }
    const deleted = await purgeTerminatedInvitations(connection);
    console.log(
      `organizationinvitations : ${deleted} document(s) supprimé(s).`,
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      'Nettoyage organizationinvitations échoué :',
      error instanceof Error ? error.name : 'erreur inconnue',
    );
    process.exitCode = 1;
  });
}
