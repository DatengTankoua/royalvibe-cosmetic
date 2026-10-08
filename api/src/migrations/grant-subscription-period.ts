/**
 * 1-14B — Attribution MANUELLE d'une période d'abonnement (outil serveur).
 *
 * Usage (après `pnpm --filter api build`) :
 *   MONGODB_URI=... pnpm --filter api subscription:grant -- \
 *     --organization-id=<24 hex> --term=monthly|quarterly|semiannual|annual \
 *     --reference=<n° de reçu> --operator=<identifiant opérateur>
 *
 * - Les 4 arguments sont requis ; les dates sont calculées par
 *   `SubscriptionsService` (heure serveur), jamais fournies.
 * - Idempotent : même référence + même organisation + même durée → même
 *   période, aucune durée ajoutée ; sinon conflit, aucune écriture.
 * - Vérifie d'abord les index requis (migration
 *   `migrate:subscription-period-indexes`) : sans eux, aucune écriture.
 * - N'écrit JAMAIS `Organization` : une organisation suspendue le reste.
 * - Ne journalise JAMAIS l'URI ni aucun secret. Code de sortie 1 en échec.
 */
import { createConnection } from 'mongoose';
import {
  Organization,
  OrganizationDocument,
  OrganizationSchema,
} from '../organizations/schemas/organization.schema';
import {
  SubscriptionPeriod,
  SubscriptionPeriodDocument,
  SubscriptionPeriodSchema,
} from '../subscriptions/schemas/subscription-period.schema';
import { verifySubscriptionPeriodIndexes } from '../subscriptions/subscription-period-indexes';
import { systemSubscriptionClock } from '../subscriptions/subscription-clock';
import {
  SubscriptionGrantError,
  SubscriptionsService,
} from '../subscriptions/subscriptions.service';

const ARGUMENTS = {
  '--organization-id': 'organizationId',
  '--term': 'term',
  '--reference': 'sourceReference',
  '--operator': 'grantedBy',
} as const;

type ParsedArguments = Record<
  (typeof ARGUMENTS)[keyof typeof ARGUMENTS],
  string
>;

/** `--clé=valeur` uniquement ; argument inconnu, dupliqué ou manquant → null. */
export function parseGrantArguments(
  argv: readonly string[],
): ParsedArguments | null {
  const parsed: Partial<ParsedArguments> = {};
  for (const arg of argv) {
    if (arg === '--') continue;
    const separator = arg.indexOf('=');
    if (separator < 0) return null;
    const flag = arg.slice(0, separator);
    if (!Object.prototype.hasOwnProperty.call(ARGUMENTS, flag)) return null;
    const field = ARGUMENTS[flag as keyof typeof ARGUMENTS];
    if (parsed[field] !== undefined) return null;
    parsed[field] = arg.slice(separator + 1);
  }
  const fields = Object.values(ARGUMENTS);
  return fields.every((field) => typeof parsed[field] === 'string')
    ? (parsed as ParsedArguments)
    : null;
}

const USAGE =
  'Usage : --organization-id=<id> --term=monthly|quarterly|semiannual|annual ' +
  '--reference=<référence> --operator=<opérateur>';

async function main(): Promise<void> {
  const args = parseGrantArguments(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI requis.');
    process.exitCode = 1;
    return;
  }
  const connection = await createConnection(uri).asPromise();
  try {
    await verifySubscriptionPeriodIndexes(connection);
    const service = new SubscriptionsService(
      connection.model<SubscriptionPeriodDocument>(
        SubscriptionPeriod.name,
        SubscriptionPeriodSchema,
      ),
      connection.model<OrganizationDocument>(
        Organization.name,
        OrganizationSchema,
      ),
      connection,
      systemSubscriptionClock,
    );
    const granted = await service.grantSubscription(args);
    console.log(
      JSON.stringify({
        result: granted.replayed ? 'already-granted' : 'granted',
        organizationId: granted.organizationId,
        term: granted.term,
        startsAt: granted.startsAt.toISOString(),
        endsAt: granted.endsAt.toISOString(),
      }),
    );
  } finally {
    await connection.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message =
      error instanceof SubscriptionGrantError
        ? `${error.code} — ${error.message}`
        : error instanceof Error
          ? error.message
          : 'erreur inconnue';
    console.error('Attribution échouée :', message);
    process.exitCode = 1;
  });
}
