import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SubscriptionsModule } from '../subscriptions.module';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
  PaymentProvider,
  UnavailablePaymentProvider,
} from './payment-provider';
import {
  PAYMENT_PROVIDER_WIRING,
  PAYMENT_RUNTIME_CONFIG,
} from './payment-providers.wiring';
import { SubscriptionPaymentsService } from './subscription-payments.service';
import { PaymentReconciliationService } from './reconciliation/payment-reconciliation.service';
import {
  SASPAY_WEBHOOK_CONFIG,
  SasPayWebhookConfig,
  SasPayWebhookService,
} from './saspay/saspay-webhook.service';
import { PaymentConfigError } from './saspay/saspay-config';

/**
 * 1-21B — Garde-fou du bac à sable pour les CONFIRMATIONS.
 *
 * Les trois chemins qui peuvent attribuer un abonnement — refresh
 * (`SubscriptionPaymentsService`), webhook (`SasPayWebhookService` →
 * `SubscriptionPaymentsService`) et CLI de rapprochement
 * (`PaymentReconciliationService`, chargé par le CLI via `AppModule`) —
 * obtiennent leurs prestataires de CONFIRMATION de ce câblage unique. En
 * `NODE_ENV=production`, une clé `sk_test_…` fait échouer sa compilation :
 * aucun de ces chemins n'existe (le processus ne démarre pas). Preuve
 * processus du CLI : `payment-reconciliation-cli-process.e2e-spec.ts`.
 */

const SANDBOX_KEY = 'sk_test_fake-wiring-sandbox-0001';
const LIVE_KEY = 'sk_live_fake-wiring-live-0001';

function compileWiring(env: Record<string, string | undefined>) {
  return Test.createTestingModule({
    providers: [
      ...PAYMENT_PROVIDER_WIRING,
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
    ],
  }).compile();
}

/** Jetons déclarés par `@Inject(...)` sur le constructeur d'une classe. */
function injectedTokens(target: object): unknown[] {
  const declared = (Reflect.getMetadata('self:paramtypes', target) ?? []) as {
    param: unknown;
  }[];
  return declared.map((d) => d.param);
}

describe('Garde-fou bac à sable pour les confirmations (1-21B)', () => {
  it('production + clé sandbox + `none` (avec ou sans secret webhook) : le câblage refuse de se construire, sans valeur affichée', async () => {
    for (const webhook of [undefined, 'whsec-wiring-guard-000001']) {
      let error: unknown;
      try {
        await compileWiring({
          NODE_ENV: 'production',
          PAYMENT_PROVIDER_ACTIVE: 'none',
          SASPAY_ENVIRONMENT: 'sandbox',
          SASPAY_SECRET_KEY: SANDBOX_KEY,
          SASPAY_WEBHOOK_SECRET: webhook,
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PaymentConfigError);
      expect(String((error as Error).message)).not.toContain(SANDBOX_KEY);
    }
  });

  it('production + clé LIVE + `none` : créations coupées, confirmations SasPay CONSERVÉES, webhook actif', async () => {
    const moduleRef = await compileWiring({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER_ACTIVE: 'none',
      SASPAY_ENVIRONMENT: 'live',
      SASPAY_SECRET_KEY: LIVE_KEY,
      SASPAY_WEBHOOK_SECRET: 'whsec-wiring-live-000001',
    });
    expect(moduleRef.get(PAYMENT_PROVIDER)).toBeInstanceOf(
      UnavailablePaymentProvider,
    );
    const confirmers = moduleRef.get<readonly PaymentProvider[]>(
      PAYMENT_CONFIRMATION_PROVIDERS,
    );
    expect(confirmers.map((p) => p.name)).toEqual(['saspay']);
    expect(
      moduleRef.get<SasPayWebhookConfig>(SASPAY_WEBHOOK_CONFIG).enabled,
    ).toBe(true);
    expect(moduleRef.get(PAYMENT_RUNTIME_CONFIG)).toMatchObject({
      active: 'none',
      saspay: { environment: 'live' },
    });
  });

  it('refresh, webhook et CLI dépendent de ce câblage unique (aucun autre fournisseur de confirmation)', () => {
    const providers = Reflect.getMetadata(
      'providers',
      SubscriptionsModule,
    ) as unknown[];
    for (const wired of PAYMENT_PROVIDER_WIRING) {
      expect(providers).toContain(wired);
    }
    const confirmationSources = providers.filter(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        (p as { provide?: unknown }).provide === PAYMENT_CONFIRMATION_PROVIDERS,
    );
    expect(confirmationSources).toHaveLength(1);
    expect(injectedTokens(SubscriptionPaymentsService)).toContain(
      PAYMENT_CONFIRMATION_PROVIDERS,
    );
    expect(injectedTokens(PaymentReconciliationService)).toContain(
      PAYMENT_CONFIRMATION_PROVIDERS,
    );
    // Webhook : configuration du même câblage, confirmation par le service.
    expect(injectedTokens(SasPayWebhookService)).toContain(
      SASPAY_WEBHOOK_CONFIG,
    );
    expect(
      Reflect.getMetadata('design:paramtypes', SasPayWebhookService),
    ).toContain(SubscriptionPaymentsService);
  });
});
