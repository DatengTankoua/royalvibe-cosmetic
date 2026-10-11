import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePublicAppOrigin } from '../../organizations/invitation-link';
import {
  PAYMENT_CONFIRMATION_PROVIDERS,
  PAYMENT_PROVIDER,
  PaymentProvider,
  UnavailablePaymentProvider,
} from './payment-provider';
import { PAYMENT_RETURN_ORIGIN } from './subscription-payments.service';
import {
  PaymentRuntimeConfig,
  SASPAY_PROVIDER_NAME,
  resolvePaymentConfig,
} from './saspay/saspay-config';
import { SasPayPaymentProvider } from './saspay/saspay-payment-provider';
import {
  DISABLED_SASPAY_WEBHOOK,
  SASPAY_WEBHOOK_CONFIG,
  SasPayWebhookConfig,
} from './saspay/saspay-webhook.service';

/**
 * 1-21B — Câblage des prestataires de paiement (production).
 *
 * - Configuration lue UNE fois (`resolvePaymentConfig`) ; incohérente →
 *   erreur au démarrage, sans valeur affichée.
 * - `PAYMENT_PROVIDER` (nouvelles tentatives) : SasPay seulement si
 *   `PAYMENT_PROVIDER_ACTIVE=saspay`, sinon `UnavailablePaymentProvider`
 *   (défaut : 503, aucun réseau).
 * - `PAYMENT_CONFIRMATION_PROVIDERS` : SasPay dès que sa clé est configurée,
 *   même avec `none` (paiements déjà engagés toujours confirmables).
 *   CamPay n'y figure jamais (jamais activé ; ses paiements éventuels ne
 *   sont confirmés par aucun autre adaptateur).
 * - Webhook SasPay : activé seulement avec `SASPAY_WEBHOOK_SECRET`.
 * - Aucun transport de test ni origine locale : le faux SasPay n'existe que
 *   dans le code de test, qui remplace ces fournisseurs.
 */
export const PAYMENT_RUNTIME_CONFIG = Symbol('PAYMENT_RUNTIME_CONFIG');
const SASPAY_PROVIDER_INSTANCE = Symbol('SASPAY_PROVIDER_INSTANCE');

const ENV_KEYS = [
  'PAYMENT_PROVIDER_ACTIVE',
  'SASPAY_ENVIRONMENT',
  'SASPAY_SECRET_KEY',
  'SASPAY_WEBHOOK_SECRET',
  'NODE_ENV',
  'JWT_SECRET',
] as const;

export const PAYMENT_PROVIDER_WIRING: Provider[] = [
  {
    provide: PAYMENT_RUNTIME_CONFIG,
    inject: [ConfigService],
    useFactory: (config: ConfigService): PaymentRuntimeConfig =>
      resolvePaymentConfig(
        Object.fromEntries(
          ENV_KEYS.map((key) => [key, config.get<string>(key)]),
        ),
      ),
  },
  {
    provide: SASPAY_PROVIDER_INSTANCE,
    inject: [PAYMENT_RUNTIME_CONFIG],
    useFactory: (runtime: PaymentRuntimeConfig): PaymentProvider | null =>
      runtime.saspay
        ? new SasPayPaymentProvider({
            environment: runtime.saspay.environment,
            secretKey: runtime.saspay.secretKey,
          })
        : null,
  },
  {
    provide: PAYMENT_PROVIDER,
    inject: [PAYMENT_RUNTIME_CONFIG, SASPAY_PROVIDER_INSTANCE],
    useFactory: (
      runtime: PaymentRuntimeConfig,
      saspay: PaymentProvider | null,
    ): PaymentProvider =>
      runtime.active === SASPAY_PROVIDER_NAME && saspay
        ? saspay
        : new UnavailablePaymentProvider(),
  },
  {
    provide: PAYMENT_CONFIRMATION_PROVIDERS,
    inject: [SASPAY_PROVIDER_INSTANCE],
    useFactory: (saspay: PaymentProvider | null): readonly PaymentProvider[] =>
      Object.freeze(saspay ? [saspay] : []),
  },
  {
    provide: SASPAY_WEBHOOK_CONFIG,
    inject: [PAYMENT_RUNTIME_CONFIG],
    useFactory: (runtime: PaymentRuntimeConfig): SasPayWebhookConfig =>
      runtime.saspay?.webhookSecret
        ? Object.freeze({
            enabled: true as const,
            secret: runtime.saspay.webhookSecret,
          })
        : DISABLED_SASPAY_WEBHOOK,
  },
  {
    provide: PAYMENT_RETURN_ORIGIN,
    inject: [ConfigService],
    useFactory: (config: ConfigService): string | null =>
      parsePublicAppOrigin(config.get<string>('PUBLIC_APP_URL')),
  },
];
