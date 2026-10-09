/**
 * 1-17B — CLI OPÉRATEUR des quotas de stockage.
 *
 * Usage depuis la RACINE du dépôt (après `pnpm --filter api build`, avec
 * l'environnement de l'API : MONGODB_URI, S3_*, JWT_SECRET) :
 *   pnpm --filter api storage:quota diagnose [--organization=<id>]
 *   pnpm --filter api storage:quota initialize [--apply] [--organization=<id>]
 *   pnpm --filter api storage:quota inventory [--apply] [--organization=<id>]
 *   pnpm --filter api storage:quota orphans [--apply] [--organization=<id>]
 *   pnpm --filter api storage:quota recover [--apply] [--organization=<id>] [--limit=<n>]
 *   pnpm --filter api storage:quota recompute [--apply] [--organization=<id>]
 * Image de production (sans pnpm), dossier /app/api :
 *   node dist/migrations/storage-quota.js diagnose
 *
 * Sans `--apply`, AUCUNE commande n'écrit (ni MongoDB ni stockage) ;
 * `diagnose` n'accepte jamais `--apply`. Codes de sortie : 0 = rien à
 * corriger, 3 = action nécessaire (détail dans la sortie), 2 = arguments,
 * 1 = erreur.
 *
 * - `diagnose` : références (photos, corbeille comprise, et logos) et taille
 *   par `HeadObject` ; inventaire du stockage (`ListObjectsV2`) ; entrées
 *   `attached` sans référence ; cohérence compteurs/registre. Aucun
 *   téléchargement.
 * - `inventory --apply` : comptabilise les fichiers présents sans entrée au
 *   registre (envoi arrivé après reprise, ancien code) ; non référencés :
 *   supprimés après délai de grâce, après nouvelle vérification.
 * - `orphans --apply` : entrées `attached` sans référence → suppression puis
 *   libération sur suppression confirmée.
 * - `initialize --apply` : comptabilise les fichiers existants non encore
 *   suivis. Relançable : un fichier déjà suivi n'est jamais recompté ;
 *   taille inconnue → non comptée (jamais 0), signalée, relancer plus tard.
 *   Sans `--apply` : identique à `diagnose`.
 * - `recover --apply` (sans `--apply` : état des lieux, aucune écriture) :
 *   reprise des réservations et suppressions dont l'échéance est
 *   dépassée (même traitement que la reprise automatique de l'API).
 * - `recompute` : reconstruit les compteurs depuis le registre
 *   (`--apply`), sinon comparaison seule.
 *
 * Contexte applicatif Nest sans serveur HTTP ; `autoIndex`/`autoCreate`
 * désactivés avant tout chargement ; `MONGODB_URI` exigé explicitement.
 * Ne journalise jamais l'URI, un secret, une clé de fichier ni une URL :
 * seulement des identifiants d'organisation, des comptages et des octets.
 */
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';

export const STORAGE_QUOTA_EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  INCOMPLETE: 3,
});

/** Stockage cible : jamais pris dans un `.env` (voir `main`). */
export const STORAGE_REQUIRED_ENV = Object.freeze([
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
]);

export const STORAGE_QUOTA_USAGE = [
  'Usage :',
  '  storage:quota diagnose [--organization=<id>]',
  '  storage:quota initialize [--apply] [--organization=<id>]',
  '  storage:quota inventory [--apply] [--organization=<id>]',
  '  storage:quota orphans [--apply] [--organization=<id>]',
  '  storage:quota recover [--apply] [--organization=<id>] [--limit=<n>]',
  '  storage:quota recompute [--apply] [--organization=<id>]',
].join('\n');

export type StorageQuotaCommand =
  | { name: 'diagnose'; organizationId?: string }
  | { name: 'initialize'; apply: boolean; organizationId?: string }
  | { name: 'inventory'; apply: boolean; organizationId?: string }
  | { name: 'orphans'; apply: boolean; organizationId?: string }
  | { name: 'recover'; apply: boolean; organizationId?: string; limit: number }
  | { name: 'recompute'; apply: boolean; organizationId?: string };

export function parseStorageQuotaArguments(
  argv: readonly string[],
): StorageQuotaCommand | { error: string } {
  const [name, ...rest] = argv.filter((a) => a !== '--');
  let apply = false;
  let organizationId: string | undefined;
  let limit = 500;
  for (const arg of rest) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--organization=')) {
      organizationId = arg.slice('--organization='.length);
      if (!/^[0-9a-f]{24}$/.test(organizationId)) {
        return { error: 'identifiant d’organisation invalide' };
      }
    } else if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length));
      if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
        return { error: '--limit doit être un entier entre 1 et 10000' };
      }
    } else {
      return { error: `argument inconnu : ${arg}` };
    }
  }
  switch (name) {
    case 'diagnose':
      if (apply) return { error: 'diagnose est toujours sans écriture' };
      return { name, organizationId };
    case 'initialize':
    case 'inventory':
    case 'orphans':
      return { name, apply, organizationId };
    case 'recover':
      return { name, apply, organizationId, limit };
    case 'recompute':
      return { name, apply, organizationId };
    default:
      return { error: 'commande attendue' };
  }
}

async function main(): Promise<number> {
  const command = parseStorageQuotaArguments(process.argv.slice(2));
  if ('error' in command) {
    console.error(
      `Arguments invalides : ${command.error}.\n${STORAGE_QUOTA_USAGE}`,
    );
    return STORAGE_QUOTA_EXIT.USAGE;
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI requis.');
    return STORAGE_QUOTA_EXIT.ERROR;
  }
  // Stockage cible fourni EXPLICITEMENT (jamais complété par un `.env` du
  // répertoire courant, lu par `ConfigModule` pour les variables absentes).
  const missing = STORAGE_REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(
      `Variables requises dans l'environnement : ${missing.join(', ')}.`,
    );
    return STORAGE_QUOTA_EXIT.ERROR;
  }
  // Avant tout modèle : aucune collection ni index créés implicitement.
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const { AppModule } = await import('../app.module.js');
  const { StorageQuotaService } =
    await import('../storage-quota/storage-quota.service.js');
  type Recomputed = Awaited<
    ReturnType<InstanceType<typeof StorageQuotaService>['recompute']>
  >;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const service = app.get(StorageQuotaService);
    const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
    const organizations = async () =>
      command.organizationId
        ? [command.organizationId]
        : await service.trackedOrganizationIds();

    if (command.name === 'recover') {
      if (!command.apply) {
        // État des lieux SANS écriture (ni MongoDB ni stockage).
        const inspection = await service.inspectRecovery({
          organizationId: command.organizationId,
        });
        out({ apply: false, ...inspection });
        return inspection.due.count === 0
          ? STORAGE_QUOTA_EXIT.OK
          : STORAGE_QUOTA_EXIT.INCOMPLETE;
      }
      const report = await service.recover({
        organizationId: command.organizationId,
        limit: command.limit,
      });
      out({ apply: true, ...report });
      return report.retry === 0
        ? STORAGE_QUOTA_EXIT.OK
        : STORAGE_QUOTA_EXIT.INCOMPLETE;
    }
    if (command.name === 'inventory') {
      const report = await service.reconcileInventory({
        apply: command.apply,
        organizationId: command.organizationId,
      });
      out(report);
      const untracked =
        (report.totals.untracked_referenced ?? 0) +
        (report.totals.untracked_unreferenced ?? 0);
      return command.apply || untracked === 0
        ? STORAGE_QUOTA_EXIT.OK
        : STORAGE_QUOTA_EXIT.INCOMPLETE;
    }
    if (command.name === 'orphans') {
      const report = await service.reconcileOrphans({
        apply: command.apply,
        organizationId: command.organizationId,
      });
      out(report);
      const pending = command.apply ? report.retry : report.orphaned;
      return pending === 0
        ? STORAGE_QUOTA_EXIT.OK
        : STORAGE_QUOTA_EXIT.INCOMPLETE;
    }
    if (command.name === 'recompute') {
      const results: Recomputed[] = [];
      for (const id of await organizations()) {
        results.push(await service.recompute(id, command.apply));
      }
      out({ apply: command.apply, results });
      return results.every((r) => r.consistent) || command.apply
        ? STORAGE_QUOTA_EXIT.OK
        : STORAGE_QUOTA_EXIT.INCOMPLETE;
    }
    const apply = command.name === 'initialize' && command.apply;
    const report = await service.initializeExisting({
      apply,
      organizationId: command.organizationId,
    });
    const counters: Recomputed[] = [];
    for (const id of await organizations()) {
      counters.push(await service.recompute(id, false));
    }
    const consistent = counters.every((c) => c.consistent);
    // `diagnose` : inventaire et entrées orphelines, en lecture seule.
    const inventory =
      command.name === 'diagnose'
        ? await service.reconcileInventory({
            apply: false,
            organizationId: command.organizationId,
          })
        : undefined;
    const orphans =
      command.name === 'diagnose'
        ? await service.reconcileOrphans({
            apply: false,
            organizationId: command.organizationId,
          })
        : undefined;
    out({
      ...report,
      limitBytes: service.config.quotaBytes,
      counters: counters.map((c) => ({
        organizationId: c.organizationId,
        consistent: c.consistent,
      })),
      ...(inventory ? { inventory } : {}),
      ...(orphans ? { orphans } : {}),
    });
    const untracked =
      (inventory?.totals.untracked_referenced ?? 0) +
      (inventory?.totals.untracked_unreferenced ?? 0);
    return report.complete &&
      consistent &&
      untracked === 0 &&
      (orphans?.orphaned ?? 0) === 0
      ? STORAGE_QUOTA_EXIT.OK
      : STORAGE_QUOTA_EXIT.INCOMPLETE;
  } finally {
    await app.close().catch(() => undefined);
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(
        'Commande storage:quota échouée :',
        error instanceof Error ? error.message : 'erreur inconnue',
      );
      process.exit(STORAGE_QUOTA_EXIT.ERROR);
    });
}
