import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  RECONCILIATION_EXIT,
  ReconciliationCommand,
  parseReconciliationArguments,
  runReconciliationCommand,
} from './payment-reconciliation-cli';
import {
  PaymentReconciliationService,
  ReconciliationError,
  ReconciliationPlan,
} from './payment-reconciliation.service';
import {
  ReconciliationAction,
  ReconciliationReason,
} from './subscription-payment-reconciliation.schema';
import {
  describeReconciliationIndexProblem,
  isReconciliationOperationDuplicate,
} from './subscription-payment-reconciliation-indexes';
import { paymentConcordanceMismatches } from '../payment-concordance';
import { SubscriptionPaymentStatus } from '../schemas/subscription-payment.schema';
import { SubscriptionsModule } from '../../subscriptions.module';
import mongoose from 'mongoose';
import { disableImplicitSchemaWrites } from '../../../migrations/reconcile-subscription-payment';

/**
 * 1-14D.2G — CLI de rapprochement : arguments STRICTS, codes de sortie,
 * concordance partagée, index d'audit. Aucun réseau, aucune base.
 */

const PAYMENT_ID = '0123456789abcdef01234567';
const REFERENCE = '2ceefe04-1a79-4914-9dd0-c61748c2aecd';
const OPERATION_ID = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7';
const PLAN = 'a'.repeat(32);
const applyArgs = (extra: string[] = []) => [
  'reconcile',
  `--payment-id=${PAYMENT_ID}`,
  '--apply',
  `--plan=${PLAN}`,
  `--operation-id=${OPERATION_ID}`,
  '--operator=ops.alice',
  '--reason=provider-statement',
  ...extra,
];

describe('Arguments du CLI', () => {
  it('inspect : --payment-id seul (normalisé en minuscules)', () => {
    expect(
      parseReconciliationArguments([
        'inspect',
        `--payment-id=${PAYMENT_ID.toUpperCase()}`,
      ]),
    ).toEqual({ command: 'inspect', paymentId: PAYMENT_ID });
    // Séparateur `--` de pnpm toléré.
    expect(
      parseReconciliationArguments([
        '--',
        'inspect',
        `--payment-id=${PAYMENT_ID}`,
      ]),
    ).toEqual({ command: 'inspect', paymentId: PAYMENT_ID });
  });

  it('reconcile sans --apply : SIMULATION, référence facultative', () => {
    expect(
      parseReconciliationArguments(['reconcile', `--payment-id=${PAYMENT_ID}`]),
    ).toEqual({
      command: 'reconcile',
      paymentId: PAYMENT_ID,
      reference: null,
      apply: false,
    });
    expect(
      parseReconciliationArguments([
        'reconcile',
        `--payment-id=${PAYMENT_ID}`,
        `--reference=${REFERENCE.toUpperCase()}`,
      ]),
    ).toMatchObject({ reference: REFERENCE, apply: false });
  });

  it('--apply : plan, opération, opérateur et motif structuré requis', () => {
    expect(
      parseReconciliationArguments(applyArgs(['--ticket=SUP-42'])),
    ).toEqual({
      command: 'reconcile',
      paymentId: PAYMENT_ID,
      reference: null,
      apply: true,
      planToken: PLAN,
      operationId: OPERATION_ID,
      operatorId: 'ops.alice',
      reasonCode: ReconciliationReason.PROVIDER_STATEMENT,
      reasonTicket: 'SUP-42',
    });
    for (const missing of [
      '--plan',
      '--operation-id',
      '--operator',
      '--reason',
    ]) {
      const args = applyArgs().filter((a) => !a.startsWith(`${missing}=`));
      expect(parseReconciliationArguments(args)).toHaveProperty('error');
    }
  });

  it.each([
    [[]],
    [['delete', `--payment-id=${PAYMENT_ID}`]],
    [['inspect']],
    [['inspect', '--payment-id=xyz']],
    [['inspect', `--payment-id=${PAYMENT_ID}`, `--reference=${REFERENCE}`]],
    [['inspect', `--payment-id=${PAYMENT_ID}`, '--apply']],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, '--reference=xyz']],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, `--plan=${PLAN}`]],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, '--operator=ops.alice']],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, `--payment-id=${PAYMENT_ID}`]],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, '--reference=']],
    [['reconcile', `--payment-id=${PAYMENT_ID}`, '--reference']],
    [applyArgs(['--apply'])],
    [applyArgs().map((a) => (a.startsWith('--plan=') ? '--plan=zz' : a))],
    [
      applyArgs().map((a) =>
        a.startsWith('--operation-id=') ? '--operation-id=not-a-uuid' : a,
      ),
    ],
    // UUID v1 / majuscules refusés : v4 canonique uniquement.
    [
      applyArgs().map((a) =>
        a.startsWith('--operation-id=')
          ? '--operation-id=6f1c2a3b-4d5e-1f60-8a71-92b3c4d5e6f7'
          : a,
      ),
    ],
    [
      applyArgs().map((a) =>
        a.startsWith('--operation-id=')
          ? `--operation-id=${OPERATION_ID.toUpperCase()}`
          : a,
      ),
    ],
    [
      applyArgs().map((a) =>
        a.startsWith('--reason=') ? '--reason=because' : a,
      ),
    ],
    [
      applyArgs().map((a) =>
        a.startsWith('--operator=') ? '--operator=a b' : a,
      ),
    ],
    [applyArgs(['--ticket=with space'])],
  ])('refusé : %j', (argv) => {
    expect(parseReconciliationArguments(argv)).toHaveProperty('error');
  });

  it('aucun drapeau ne sélectionne un prestataire (faux, simulé ou autre)', () => {
    for (const flag of [
      '--provider=simulated',
      '--provider=campay',
      '--fake-provider',
      '--simulate',
      '--env=demo',
    ]) {
      expect(
        parseReconciliationArguments([
          'reconcile',
          `--payment-id=${PAYMENT_ID}`,
          flag,
        ]),
      ).toHaveProperty('error');
    }
    // Le point d'entrée résout le fournisseur INJECTÉ par `AppModule`.
    const main = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'migrations',
        'reconcile-subscription-payment.ts',
      ),
      'utf8',
    );
    // Code seul (commentaires retirés).
    const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('createApplicationContext(AppModule');
    expect(code).not.toMatch(
      /overrideProvider|PAYMENT_PROVIDER|Simulated|CamPay/,
    );
  });
});

// ─── Exécution et codes de sortie ────────────────────────────────────────────

const readyPlan: ReconciliationPlan = {
  decision: 'ready',
  action: ReconciliationAction.SUCCEED,
  paymentId: PAYMENT_ID,
  before: {
    status: SubscriptionPaymentStatus.UNCERTAIN,
    open: true,
    providerReference: null,
  },
  consultedReference: REFERENCE,
  referenceAttach: true,
  verified: {
    state: 'succeeded',
    providerReference: REFERENCE,
    merchantReference: 'SM0123456789ABCDEF01234567',
    amount: 3000,
    currency: 'XAF',
  },
  after: {
    status: SubscriptionPaymentStatus.SUCCEEDED,
    open: false,
    grantsPeriod: true,
  },
  planToken: PLAN,
};
const blockedPlan: ReconciliationPlan = {
  decision: 'blocked',
  reason: 'mismatch',
  paymentId: PAYMENT_ID,
  before: readyPlan.before,
  consultedReference: REFERENCE,
  verified: { ...readyPlan.verified, amount: null },
  mismatches: ['amount'],
};

function fakeService(
  overrides: Partial<Record<'inspect' | 'plan' | 'apply', jest.Mock>>,
) {
  return {
    inspect: overrides.inspect ?? jest.fn(),
    plan: overrides.plan ?? jest.fn(),
    apply: overrides.apply ?? jest.fn(),
  } as unknown as PaymentReconciliationService;
}

async function run(
  command: ReconciliationCommand,
  service: PaymentReconciliationService,
) {
  const out: unknown[] = [];
  const err: string[] = [];
  const code = await runReconciliationCommand(command, service, {
    out: (v) => out.push(v),
    err: (m) => err.push(m),
  });
  return { code, out, err };
}

const parsed = (argv: string[]) => {
  const command = parseReconciliationArguments(argv);
  if ('error' in command) throw new Error(command.error);
  return command;
};

describe('Codes de sortie', () => {
  it('simulation prête → 0 ; bloquée → 4 ; jamais d’application', async () => {
    const apply = jest.fn();
    let r = await run(
      parsed(['reconcile', `--payment-id=${PAYMENT_ID}`]),
      fakeService({ plan: jest.fn().mockResolvedValue(readyPlan), apply }),
    );
    expect(r.code).toBe(RECONCILIATION_EXIT.OK);
    expect(r.out[0]).toMatchObject({ mode: 'simulation', plan: readyPlan });
    r = await run(
      parsed(['reconcile', `--payment-id=${PAYMENT_ID}`]),
      fakeService({ plan: jest.fn().mockResolvedValue(blockedPlan), apply }),
    );
    expect(r.code).toBe(RECONCILIATION_EXIT.BLOCKED);
    expect(apply).not.toHaveBeenCalled();
  });

  it('application : appliqué/rejoué → 0 ; bloqué → 4 ; erreurs typées → 3, 2, 5, 6, 7', async () => {
    const applied = {
      result: 'applied',
      operationId: OPERATION_ID,
      paymentId: PAYMENT_ID,
    };
    expect(
      (
        await run(
          parsed(applyArgs()),
          fakeService({ apply: jest.fn().mockResolvedValue(applied) }),
        )
      ).code,
    ).toBe(0);
    expect(
      (
        await run(
          parsed(applyArgs()),
          fakeService({ apply: jest.fn().mockResolvedValue(blockedPlan) }),
        )
      ).code,
    ).toBe(4);
    for (const [code, exit] of [
      ['PAYMENT_NOT_FOUND', 3],
      ['INVALID_REFERENCE', 2],
      ['PLAN_STALE', 5],
      ['OPERATION_CONFLICT', 6],
      ['CONFIRMATION_PENDING', 7],
    ] as const) {
      const r = await run(
        parsed(applyArgs()),
        fakeService({
          apply: jest
            .fn()
            .mockRejectedValue(
              new ReconciliationError(
                code,
                'msg',
                code === 'PLAN_STALE' ? readyPlan : null,
              ),
            ),
        }),
      );
      expect(r.code).toBe(exit);
      expect(r.out[0]).toMatchObject({ error: code });
      if (code === 'PLAN_STALE') expect(r.out[0]).toHaveProperty('currentPlan');
    }
  });

  it('erreur inattendue → 1, message générique sans détail', async () => {
    const r = await run(
      parsed(['inspect', `--payment-id=${PAYMENT_ID}`]),
      fakeService({
        inspect: jest
          .fn()
          .mockRejectedValue(
            new Error('mongodb://user:secret@host/db timeout'),
          ),
      }),
    );
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.join(' ')).not.toContain('secret');
    expect(r.err.join(' ')).not.toContain('mongodb://');
  });
});

describe('Concordance partagée (moteur unique)', () => {
  const payment = { merchantReference: 'SMX', amount: 3000, currency: 'XAF' };
  const status = (o: Record<string, unknown> = {}) => ({
    state: 'succeeded' as const,
    providerReference: REFERENCE,
    merchantReference: 'SMX',
    amount: 3000 as unknown,
    currency: 'XAF' as unknown,
    ...o,
  });

  it('concordance exacte ; référence attendue imposée ou libre (`null`)', () => {
    expect(paymentConcordanceMismatches(payment, status(), REFERENCE)).toEqual(
      [],
    );
    expect(paymentConcordanceMismatches(payment, status(), null)).toEqual([]);
    expect(
      paymentConcordanceMismatches(
        payment,
        status({ providerReference: 'other' }),
        REFERENCE,
      ),
    ).toEqual(['providerReference']);
  });

  it.each([
    [{ amount: null }, ['amount']],
    [{ amount: '3000' }, ['amount']],
    [{ amount: 3000.5 }, ['amount']],
    [{ amount: 2999 }, ['amount']],
    [{ amount: undefined }, ['amount']],
    [{ currency: null }, ['currency']],
    [{ currency: 'xaf' }, ['currency']],
    [{ merchantReference: null }, ['merchantReference']],
    [{ providerReference: '' }, ['providerReference']],
  ])('discordance %j', (override, expected) => {
    expect(
      paymentConcordanceMismatches(payment, status(override), REFERENCE),
    ).toEqual(expected);
  });
});

describe('Démarrage du CLI : aucune écriture implicite de schéma', () => {
  it('désactive autoIndex et autoCreate (options de base de Mongoose)', () => {
    const previous = {
      autoIndex: mongoose.get('autoIndex') as unknown,
      autoCreate: mongoose.get('autoCreate') as unknown,
    };
    try {
      disableImplicitSchemaWrites();
      expect(mongoose.get('autoIndex')).toBe(false);
      expect(mongoose.get('autoCreate')).toBe(false);
    } finally {
      mongoose.set('autoIndex', previous.autoIndex as boolean);
      mongoose.set('autoCreate', previous.autoCreate as boolean);
    }
  });

  it('ordre : arguments, puis MONGODB_URI, puis protection, puis chargement de l’application', () => {
    const source = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'migrations',
        'reconcile-subscription-payment.ts',
      ),
      'utf8',
    );
    const main = source.slice(source.indexOf('async function main'));
    const at = (needle: string) => {
      const index = main.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    const parse = at('parseReconciliationArguments(');
    const uri = at('process.env.MONGODB_URI');
    const guard = at('disableImplicitSchemaWrites();');
    const load = at("import('../app.module.js')");
    expect(parse).toBeLessThan(uri);
    expect(uri).toBeLessThan(guard);
    expect(guard).toBeLessThan(load);
    // Aucun import STATIQUE de l'application (qui chargerait `.env`).
    expect(source).not.toMatch(/^import .*app\.module/m);
  });
});

describe('Index d’audit et module', () => {
  it('index exacts requis ; TTL, unicité ou absence refusés', () => {
    const ok = [
      { name: '_id_', key: { _id: 1 } },
      { name: 'operationId_1', key: { operationId: 1 }, unique: true },
      { name: 'paymentId_1__id_-1', key: { paymentId: 1, _id: -1 } },
    ];
    expect(describeReconciliationIndexProblem(ok)).toBeNull();
    expect(describeReconciliationIndexProblem(ok.slice(0, 2))).toMatch(
      /index absent/,
    );
    expect(
      describeReconciliationIndexProblem([
        ok[0],
        { ...ok[1], unique: false },
        ok[2],
      ]),
    ).toMatch(/unicité inattendue/);
    expect(
      describeReconciliationIndexProblem([
        ...ok,
        { name: 'ttl', key: { appliedAt: 1 }, expireAfterSeconds: 60 },
      ]),
    ).toMatch(/TTL interdit/);
  });

  it('E11000 sur l’identifiant d’opération reconnu, autres clés non', () => {
    expect(
      isReconciliationOperationDuplicate({
        code: 11000,
        keyPattern: { operationId: 1 },
      }),
    ).toBe(true);
    expect(
      isReconciliationOperationDuplicate({
        code: 11000,
        keyPattern: { provider: 1, providerReference: 1 },
      }),
    ).toBe(false);
  });

  it('aucun contrôleur ajouté : le rapprochement n’est exposé par aucune route', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      SubscriptionsModule,
    ) as { name: string }[];
    expect(controllers.map((c) => c.name).sort()).toEqual(
      [
        'CamPayWebhookController',
        'SubscriptionPaymentsController',
        'SubscriptionsController',
      ].sort(),
    );
  });
});
