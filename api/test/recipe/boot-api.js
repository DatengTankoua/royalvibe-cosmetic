/**
 * 1-14D.2H — Entrée de TEST de l'API compilée pour la recette locale.
 *
 * Réplique `src/main.ts` (options de bootstrap, trust proxy, CORS, pipes,
 * filtre) sur `dist/`, avec des remplacements injectés par
 * `overrideProvider` DEPUIS CE FICHIER UNIQUEMENT :
 * - expéditeur d'e-mails : fichier local `mail.jsonl` (jamais Resend) ;
 * - fournisseur de paiement, selon `RECIPE_PROVIDER` (lu ICI seulement) :
 *   - `simulated` : prestataire simulé (contrat D.2C) piloté par le lanceur ;
 *   - `campay` : VRAI adaptateur CamPay et VRAI transport `fetch`, dont
 *     l'origine officielle est redirigée vers le faux CamPay du lanceur
 *     (127.0.0.1), et webhook ACTIVÉ avec une clé FICTIVE.
 * - 1-16A, notifications push : activées avec une paire VAPID FICTIVE
 *   générée pour la recette et un transport SIMULÉ qui écrit chaque message
 *   dans `push.jsonl` (aucune requête vers un service push) ; traitement de
 *   fond démarré toutes les secondes.
 *
 * Ce fichier est hors `dist/` (`tsconfig.build.json` exclut `test/`) : aucun
 * binaire de production ne contient ces remplacements, et `main.ts` n'en
 * connaît aucun. L'API n'écoute que sur 127.0.0.1.
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const path = require('path');
const C = require('./recipe-common');

async function main() {
  const uri = C.assertRecipeUri(process.env.MONGODB_URI);
  const provider = process.env.RECIPE_PROVIDER;
  if (!C.PROVIDERS.includes(provider))
    throw new Error('RECIPE_PROVIDER invalide.');
  if (process.env.RECIPE_LAUNCHED !== '1')
    throw new Error('À lancer par recipe.js start.');

  // AVANT tout modèle : aucune collection ni index implicites (fonction du
  // CLI D.2G, même instance Mongoose que @nestjs/mongoose).
  const { disableImplicitSchemaWrites } = C.dist(
    'migrations/reconcile-subscription-payment',
  );
  disableImplicitSchemaWrites();
  assertImplicitWritesDisabled();

  const { ValidationPipe } = C.apiRequire('@nestjs/common');
  const { Test } = C.apiRequire('@nestjs/testing');
  const { AppModule } = C.dist('app.module');
  const { API_APPLICATION_OPTIONS } = C.dist('common/application-options');
  const { HttpExceptionFilter } = C.dist(
    'common/filters/http-exception.filter',
  );
  const { buildHttpCorsOptions, buildOriginAllowlist, parseCORSOrigin } =
    C.dist('events/origin.helpers');
  const { applyTrustProxy, resolveTrustProxySetting } =
    C.dist('common/trust-proxy');
  const { EMAIL_SENDER } = C.dist('email-verification/email-sender');
  const { PAYMENT_PROVIDER } = C.dist(
    'subscriptions/payments/payment-provider',
  );
  const { CAMPAY_WEBHOOK_CONFIG } = C.dist(
    'subscriptions/payments/campay/campay-webhook.config',
  );
  const { PAYMENT_CONFIRMATION_PROVIDERS } = C.dist(
    'subscriptions/payments/payment-provider',
  );
  const { SASPAY_WEBHOOK_CONFIG } = C.dist(
    'subscriptions/payments/saspay/saspay-webhook.service',
  );
  const { PAYMENT_RETURN_ORIGIN } = C.dist(
    'subscriptions/payments/subscription-payments.service',
  );

  const corsAllowlist = buildOriginAllowlist(
    parseCORSOrigin(process.env.CORS_ORIGIN, 'production'),
  );
  const trustProxy = resolveTrustProxySetting(process.env);

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue(fileEmailSender())
    .overrideProvider(PAYMENT_PROVIDER)
    .useValue(
      provider === 'campay'
        ? campayProvider()
        : provider === 'saspay'
          ? sasPayRecipeProvider()
          : simulatedProvider(),
    );
  if (provider === 'saspay') {
    builder = builder
      .overrideProvider(PAYMENT_CONFIRMATION_PROVIDERS)
      .useValue([sasPayRecipeProvider()])
      .overrideProvider(SASPAY_WEBHOOK_CONFIG)
      .useValue({ enabled: true, secret: C.FAKE.saspayWebhookSecret })
      .overrideProvider(PAYMENT_RETURN_ORIGIN)
      .useValue(C.WEB_ORIGIN);
  }
  if (provider === 'campay') {
    builder = builder
      .overrideProvider(CAMPAY_WEBHOOK_CONFIG)
      .useValue({ enabled: true, webhookKey: C.FAKE.webhookKey });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(API_APPLICATION_OPTIONS);
  applyTrustProxy(app.getHttpAdapter().getInstance(), trustProxy);
  app.enableCors(buildHttpCorsOptions(corsAllowlist));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  activateSimulatedPush(app);
  await app.listen(C.PORTS.api, C.HOST);
  console.log(
    `API READY provider=${provider} ${C.API_URL} (base ${new URL(uri).pathname})`,
  );
}

/** Fichier des messages push « envoyés » par le transport simulé. */
const PUSH_FILE = path.join(C.STATE_DIR, 'push.jsonl');
const VAPID_FILE = path.join(C.STATE_DIR, 'push-vapid.json');

/**
 * 1-16A — Paire VAPID FICTIVE (stable pendant la recette, régénérée à chaque
 * nouvelle stack) et transport simulé : la politique d'endpoint est appliquée
 * comme en production, puis le message est consigné localement.
 */
function activateSimulatedPush(app) {
  const { PushRuntime } = C.dist('push/push-runtime');
  const { PushDispatcherService } = C.dist('push/push-dispatcher.service');
  const { isAllowedPushEndpoint } = C.dist('push/push-endpoint-policy');
  if (!fs.existsSync(VAPID_FILE)) {
    const ecdh = require('crypto').createECDH('prime256v1');
    ecdh.generateKeys();
    fs.writeFileSync(
      VAPID_FILE,
      JSON.stringify({
        publicKey: ecdh.getPublicKey().toString('base64url'),
        privateKey: ecdh.getPrivateKey().toString('base64url'),
      }),
    );
  }
  const pair = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
  const transport = {
    async send(target, payload, options) {
      if (!isAllowedPushEndpoint(target.endpoint)) {
        return { statusCode: null, error: 'refused-endpoint' };
      }
      fs.appendFileSync(
        PUSH_FILE,
        `${JSON.stringify({ endpoint: target.endpoint, payload: JSON.parse(payload), options })}
`,
      );
      return { statusCode: 201 };
    },
  };
  app.get(PushRuntime).activate(
    {
      enabled: true,
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      subject: 'mailto:recette@recette.local',
    },
    transport,
  );
  app.get(PushDispatcherService).start(1000);
}

function assertImplicitWritesDisabled() {
  const nestMongoose = path.dirname(
    require.resolve('@nestjs/mongoose/package.json', { paths: [C.API_DIR] }),
  );
  const mongoose = require(
    require.resolve('mongoose', { paths: [nestMongoose] }),
  );
  if (
    mongoose.get('autoIndex') !== false ||
    mongoose.get('autoCreate') !== false
  ) {
    throw new Error(
      'autoIndex/autoCreate non neutralisés sur l’instance de @nestjs/mongoose.',
    );
  }
}

function fileEmailSender() {
  return {
    isConfigured: () => true,
    async send(email) {
      fs.appendFileSync(
        C.MAIL_FILE,
        // 1-16C.1 : Reply-To et clé d'idempotence consignés (assistance).
        `${JSON.stringify({ to: email.to, subject: email.subject, text: email.text, replyTo: email.replyTo ?? null, idempotencyKey: email.idempotencyKey })}\n`,
      );
    },
  };
}

/** Prestataire SIMULÉ (contrat D.2C) : état et scripts dans le lanceur. */
function simulatedProvider() {
  const { PaymentProviderUncertainError, PaymentProviderUnavailableError } =
    C.dist('subscriptions/payments/payment-provider');
  return {
    name: 'simulated',
    available: true,
    supportsMerchantReferenceLookup: true,
    idempotentInitiation: false,
    async initiate(request) {
      let reply;
      try {
        reply = await C.control('/sim/provider/initiate', {
          merchantReference: request.merchantReference,
          amount: request.amount,
          currency: request.currency,
          phoneLength: request.payerPhone.length,
        });
      } catch {
        // Simulateur injoignable : la demande n'a pas été transmise.
        throw new PaymentProviderUnavailableError();
      }
      if (reply.error === 'unavailable')
        throw new PaymentProviderUnavailableError();
      if (reply.error === 'uncertain')
        throw new PaymentProviderUncertainError();
      return reply.result;
    },
    async fetchStatus(lookup) {
      const reply = await C.control('/sim/provider/status', { lookup });
      if (reply.error) throw new Error('simulated status outage');
      return reply.status;
    },
  };
}

/**
 * VRAI adaptateur CamPay + VRAI transport de production (`fetch`,
 * redirections refusées, annulation, classification des échecs). Seule
 * l'origine officielle de démonstration est remplacée par le faux CamPay
 * local ; toute autre URL est refusée (jamais de réseau externe).
 */
function campayProvider() {
  const { CamPayPaymentProvider, CAMPAY_ORIGINS } = C.dist(
    'subscriptions/payments/campay/campay-payment-provider',
  );
  const { fetchCamPayTransport, CamPayTransportError } = C.dist(
    'subscriptions/payments/campay/campay-transport',
  );
  const loopbackTransport = (request) => {
    const url = new URL(request.url);
    if (url.origin !== CAMPAY_ORIGINS.demo) {
      return Promise.reject(new CamPayTransportError('not-sent'));
    }
    return fetchCamPayTransport({
      ...request,
      url: `${C.CONTROL_URL}/campay${url.pathname}${url.search}`,
    });
  };
  return new CamPayPaymentProvider({
    environment: 'demo',
    username: C.FAKE.campayUsername,
    password: C.FAKE.campayPassword,
    transport: loopbackTransport,
  });
}

/**
 * 1-21B — VRAI adaptateur SasPay (checkout hébergé) + VRAI transport de
 * production ; seule l'origine officielle de l'API est remplacée par le faux
 * SasPay local (`/saspay/api/v1` du serveur de contrôle). Toute autre URL
 * est refusée. Une seule instance (création et confirmation).
 */
let sasPayInstance = null;
function sasPayRecipeProvider() {
  if (sasPayInstance) return sasPayInstance;
  const { SasPayPaymentProvider, SASPAY_API_ORIGIN } = C.dist(
    'subscriptions/payments/saspay/saspay-payment-provider',
  );
  const { fetchSasPayTransport, SasPayTransportError } = C.dist(
    'subscriptions/payments/saspay/saspay-transport',
  );
  const loopback = (request) => {
    const url = new URL(request.url);
    if (url.origin !== SASPAY_API_ORIGIN) {
      return Promise.reject(new SasPayTransportError('not-sent'));
    }
    return fetchSasPayTransport({
      ...request,
      url: `${C.CONTROL_URL}/saspay${url.pathname}${url.search}`,
    });
  };
  sasPayInstance = new SasPayPaymentProvider({
    environment: 'sandbox',
    secretKey: C.FAKE.saspayKey,
    transport: loopback,
  });
  return sasPayInstance;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`API de recette interrompue : ${error && error.message}`);
    process.exit(1);
  });
}

module.exports = { campayProvider, assertImplicitWritesDisabled };
