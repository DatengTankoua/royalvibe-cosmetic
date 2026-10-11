import {
  ReconciliationError,
  PaymentReconciliationService,
} from './payment-reconciliation.service';
import { ReconciliationReason } from './subscription-payment-reconciliation.schema';

/**
 * 1-14D.2G — Analyse des arguments et exécution du CLI de rapprochement.
 *
 *   inspect   --payment-id=<24 hex>
 *   reconcile --payment-id=<24 hex> [--reference=<UUID CamPay>]
 *             (SIMULATION par défaut : consultation en lecture, aucune écriture)
 *   reconcile --payment-id=<24 hex> [--reference=<UUID>] --apply
 *             --plan=<jeton de la simulation> --operation-id=<UUID v4>
 *             --operator=<identifiant> --reason=<motif> [--ticket=<référence>]
 *
 * Aucun drapeau ne sélectionne un prestataire : le fournisseur est celui
 * injecté par l'application (`PAYMENT_PROVIDER`).
 */

export const RECONCILIATION_EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  BLOCKED: 4,
  PLAN_STALE: 5,
  OPERATION_CONFLICT: 6,
  RETRY: 7,
} as const);

export const RECONCILIATION_USAGE = [
  'Usage :',
  '  inspect   --payment-id=<id>',
  '  reconcile --payment-id=<id> [--reference=<uuid>]            (simulation)',
  '            [--close-unresolved]  page de paiement close sans succès,',
  '                                  absence de débit confirmée par le prestataire',
  '  reconcile --payment-id=<id> [--reference=<uuid>] --apply --plan=<jeton>',
  '            --operation-id=<uuid v4> --operator=<identifiant>',
  `            --reason=${Object.values(ReconciliationReason).join('|')} [--ticket=<référence>]`,
].join('\n');

export type ReconciliationCommand =
  | { command: 'inspect'; paymentId: string }
  | {
      command: 'reconcile';
      paymentId: string;
      reference: string | null;
      apply: false;
      closeUnresolved?: boolean;
    }
  | {
      command: 'reconcile';
      paymentId: string;
      reference: string | null;
      apply: true;
      planToken: string;
      operationId: string;
      operatorId: string;
      reasonCode: ReconciliationReason;
      reasonTicket: string | null;
      closeUnresolved?: boolean;
    };

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_TOKEN = /^[0-9a-f]{32}$/;
const OPERATOR = /^[A-Za-z0-9._@-]{2,64}$/;
const TICKET = /^[A-Za-z0-9._:#/-]{1,64}$/;

const FLAGS: Readonly<Record<string, string>> = Object.freeze({
  '--payment-id': 'paymentId',
  '--reference': 'reference',
  '--plan': 'planToken',
  '--operation-id': 'operationId',
  '--operator': 'operatorId',
  '--reason': 'reasonCode',
  '--ticket': 'reasonTicket',
});
const APPLY_ONLY = [
  'planToken',
  'operationId',
  'operatorId',
  'reasonCode',
  'reasonTicket',
];

/** Arguments STRICTS : inconnu, dupliqué, vide ou mal formé → erreur. */
export function parseReconciliationArguments(
  argv: readonly string[],
): ReconciliationCommand | { error: string } {
  const args = argv.filter((arg) => arg !== '--');
  const [command, ...rest] = args;
  if (command !== 'inspect' && command !== 'reconcile') {
    return { error: 'commande inconnue' };
  }
  const values: Record<string, string> = {};
  let apply = false;
  let closeUnresolved = false;
  for (const arg of rest) {
    if (arg === '--apply') {
      if (apply) return { error: '--apply dupliqué' };
      apply = true;
      continue;
    }
    // 1-21B : clôture explicite d'une page de paiement close sans succès.
    if (arg === '--close-unresolved') {
      if (closeUnresolved) return { error: '--close-unresolved dupliqué' };
      closeUnresolved = true;
      continue;
    }
    const separator = arg.indexOf('=');
    const flag = separator < 0 ? arg : arg.slice(0, separator);
    const field = Object.prototype.hasOwnProperty.call(FLAGS, flag)
      ? FLAGS[flag]
      : undefined;
    if (!field || separator < 0)
      return { error: `argument invalide : ${flag}` };
    if (values[field] !== undefined) return { error: `${flag} dupliqué` };
    const value = arg.slice(separator + 1);
    if (value.length === 0) return { error: `${flag} vide` };
    values[field] = value;
  }

  if (!values.paymentId || !OBJECT_ID.test(values.paymentId)) {
    return { error: '--payment-id=<24 hexadécimaux> requis' };
  }
  const paymentId = values.paymentId.toLowerCase();
  if (command === 'inspect') {
    if (apply || closeUnresolved || Object.keys(values).length !== 1) {
      return { error: 'inspect accepte seulement --payment-id' };
    }
    return { command, paymentId };
  }
  if (values.reference !== undefined && !UUID.test(values.reference)) {
    return { error: '--reference doit être un UUID' };
  }
  const reference = values.reference?.toLowerCase() ?? null;
  if (!apply) {
    if (APPLY_ONLY.some((field) => values[field] !== undefined)) {
      return { error: 'options d’application sans --apply' };
    }
    return {
      command,
      paymentId,
      reference,
      apply: false,
      ...(closeUnresolved ? { closeUnresolved } : {}),
    };
  }
  if (!values.planToken || !PLAN_TOKEN.test(values.planToken)) {
    return { error: '--plan=<jeton de 32 hexadécimaux> requis' };
  }
  if (!values.operationId || !UUID_V4.test(values.operationId)) {
    return { error: '--operation-id=<UUID v4 en minuscules> requis' };
  }
  if (!values.operatorId || !OPERATOR.test(values.operatorId)) {
    return { error: '--operator=<identifiant> requis' };
  }
  if (
    !values.reasonCode ||
    !(Object.values(ReconciliationReason) as string[]).includes(
      values.reasonCode,
    )
  ) {
    return { error: '--reason=<motif structuré> requis' };
  }
  if (values.reasonTicket !== undefined && !TICKET.test(values.reasonTicket)) {
    return { error: '--ticket invalide' };
  }
  return {
    command,
    paymentId,
    reference,
    apply: true,
    planToken: values.planToken,
    operationId: values.operationId,
    operatorId: values.operatorId,
    reasonCode: values.reasonCode as ReconciliationReason,
    reasonTicket: values.reasonTicket ?? null,
    ...(closeUnresolved ? { closeUnresolved } : {}),
  };
}

export interface ReconciliationOutput {
  out(value: unknown): void;
  err(message: string): void;
}

const EXIT_BY_ERROR: Readonly<Record<ReconciliationError['code'], number>> =
  Object.freeze({
    PAYMENT_NOT_FOUND: RECONCILIATION_EXIT.NOT_FOUND,
    INVALID_REFERENCE: RECONCILIATION_EXIT.USAGE,
    PLAN_STALE: RECONCILIATION_EXIT.PLAN_STALE,
    OPERATION_CONFLICT: RECONCILIATION_EXIT.OPERATION_CONFLICT,
    CONFIRMATION_PENDING: RECONCILIATION_EXIT.RETRY,
  });

/**
 * Exécute une commande déjà validée. Sortie JSON (aucun téléphone, jeton,
 * signature ni réponse brute). Code : 0 succès ou plan prêt ; 4 bloqué
 * (consultation impossible comprise : relancer plus tard) ; autres selon
 * `RECONCILIATION_EXIT`.
 */
export async function runReconciliationCommand(
  command: ReconciliationCommand,
  service: PaymentReconciliationService,
  output: ReconciliationOutput,
): Promise<number> {
  try {
    if (command.command === 'inspect') {
      output.out({
        command: 'inspect',
        payment: await service.inspect(command.paymentId),
      });
      return RECONCILIATION_EXIT.OK;
    }
    if (!command.apply) {
      const plan = await service.plan(command.paymentId, command.reference, {
        closeUnresolved: command.closeUnresolved === true,
      });
      output.out({ command: 'reconcile', mode: 'simulation', plan });
      return plan.decision === 'ready'
        ? RECONCILIATION_EXIT.OK
        : RECONCILIATION_EXIT.BLOCKED;
    }
    const result = await service.apply(
      command.paymentId,
      command.reference,
      {
        operationId: command.operationId,
        operatorId: command.operatorId,
        reasonCode: command.reasonCode,
        reasonTicket: command.reasonTicket,
        planToken: command.planToken,
      },
      { closeUnresolved: command.closeUnresolved === true },
    );
    if ('decision' in result) {
      output.out({
        command: 'reconcile',
        mode: 'apply',
        result: 'blocked',
        plan: result,
      });
      return RECONCILIATION_EXIT.BLOCKED;
    }
    output.out({ command: 'reconcile', mode: 'apply', ...result });
    return RECONCILIATION_EXIT.OK;
  } catch (error) {
    if (error instanceof ReconciliationError) {
      output.out({
        command: command.command,
        error: error.code,
        message: error.message,
        ...(error.currentPlan ? { currentPlan: error.currentPlan } : {}),
      });
      return EXIT_BY_ERROR[error.code];
    }
    // Message générique : jamais l'URI, une requête ou une réponse brute.
    output.err(
      `Rapprochement interrompu (${error instanceof Error ? error.name : 'erreur'}). Aucune donnée n'est affichée.`,
    );
    return RECONCILIATION_EXIT.ERROR;
  }
}
