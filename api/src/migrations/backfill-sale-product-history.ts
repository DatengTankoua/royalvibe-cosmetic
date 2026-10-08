/**
 * 1-15D — CLI OPÉRATEUR : rattrapage de l'historique des ventes dont le
 * produit a été supprimé définitivement avant 1-15D.
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api sales:backfill-product-history -- [--organization-id=<id>]
 *   MONGODB_URI=... pnpm --filter api sales:backfill-product-history -- [--organization-id=<id>] --apply
 *
 * - Simulation par défaut (aucune écriture) ; `--apply` pour écrire.
 * - Jamais exécuté automatiquement (ni au démarrage, ni par une migration).
 * - Rejouable sans effet (`lastKnownSource` déjà posé → vente ignorée).
 * - Sortie : rapport JSON (compteurs et identifiants de ventes
 *   irrécupérables) ; ne journalise JAMAIS l'URI, un nom ni un prix.
 * - Codes de sortie : 0 succès, 1 erreur, 2 arguments invalides.
 */
import { createConnection } from 'mongoose';
import {
  backfillSaleProductHistory,
  parseBackfillArguments,
} from '../sales/sale-history-backfill';

const USAGE =
  'Usage : sales:backfill-product-history [--organization-id=<id>] [--apply]';

async function main(): Promise<number> {
  const options = parseBackfillArguments(process.argv.slice(2));
  if ('error' in options) {
    console.error(`Arguments invalides : ${options.error}.\n${USAGE}`);
    return 2;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    return 1;
  }
  // Connexion dédiée, sans modèle : aucune collection ni index créés.
  const connection = await createConnection(uri, {
    autoIndex: false,
    autoCreate: false,
  }).asPromise();
  try {
    const report = await backfillSaleProductHistory(connection, options);
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        'Rattrapage de l’historique des ventes échoué :',
        error instanceof Error ? error.message : 'erreur inconnue',
      );
      process.exitCode = 1;
    },
  );
}
