/**
 * 1-20A — Entrée de TEST de l'API compilée pour la campagne de charge.
 *
 * Réplique `src/main.ts` sur `dist/` (fuseau, CORS strict, trust proxy,
 * anti-robot et plafonds validés, pipes, filtre, centre de notifications,
 * traitement de fond à l'intervalle de PRODUCTION, reprise du stockage),
 * avec, depuis CE fichier uniquement :
 * - expéditeur d'e-mails : fichier local (jamais Resend) ;
 * - transport push SIMULÉ : politique d'endpoint de production appliquée,
 *   puis message consigné localement (aucun service push contacté) ;
 * - mesures internes du processus (CPU, mémoire, retard de la boucle
 *   événementielle, sockets Socket.IO, pool MongoDB) écrites chaque seconde
 *   dans `metrics-api.jsonl`. Aucune route n'est ajoutée à l'API.
 *
 * `autoIndex` n'est PAS neutralisé : comme en production, les index déclarés
 * des schémas sont garantis par Mongoose ; les autres viennent des
 * migrations de pré-déploiement exécutées par le lanceur.
 * Authentification, permissions, abonnement et transactions : inchangés.
 */
'use strict';

require('../recipe/preload.cjs');
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');
const L = require('./load-common');

const { R } = L;

async function main() {
  L.assertLoadUri(process.env.MONGODB_URI);
  if (process.env.LOAD_LAUNCHED !== '1')
    throw new Error('À lancer par load-stack.js start.');

  const { configureProcessTimeZone } = L.dist('analytics/month-range');
  configureProcessTimeZone();
  const { Test } = R.apiRequire('@nestjs/testing');
  const { ValidationPipe } = R.apiRequire('@nestjs/common');
  const { getConnectionToken } = R.apiRequire('@nestjs/mongoose');
  const { AppModule } = L.dist('app.module');
  const { API_APPLICATION_OPTIONS } = L.dist('common/application-options');
  const { HttpExceptionFilter } = L.dist(
    'common/filters/http-exception.filter',
  );
  const { buildHttpCorsOptions, buildOriginAllowlist, parseCORSOrigin } =
    L.dist('events/origin.helpers');
  const { applyTrustProxy, resolveTrustProxySetting } =
    L.dist('common/trust-proxy');
  const { resolveTurnstileConfig } = L.dist('anti-bot/turnstile-config');
  const { resolveAntiAbuseConfig } = L.dist(
    'common/rate-limit/anti-abuse-config',
  );
  const { EMAIL_SENDER } = L.dist('email-verification/email-sender');
  const { verifyPushIndexes } = L.dist('push/push-indexes');
  const { PushRuntime } = L.dist('push/push-runtime');
  const { PushDispatcherService } = L.dist('push/push-dispatcher.service');
  const { isAllowedPushEndpoint } = L.dist('push/push-endpoint-policy');
  const { startStorageRecovery } = L.dist('storage-quota/storage-recovery');
  const { EventsGateway } = L.dist('events/events.gateway');

  const corsAllowlist = buildOriginAllowlist(
    parseCORSOrigin(process.env.CORS_ORIGIN, 'production'),
  );
  const trustProxy = resolveTrustProxySetting(process.env);
  resolveTurnstileConfig(process.env);
  resolveAntiAbuseConfig(process.env);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(EMAIL_SENDER)
    .useValue({
      isConfigured: () => true,
      async send(email) {
        fs.appendFileSync(
          L.MAIL_FILE,
          `${JSON.stringify({ to: email.to, subject: email.subject })}\n`,
        );
      },
    })
    .compile();
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

  // Même ordre que `startNotifications` (production) : index vérifiés,
  // runtime activé (push simulé), traitement de fond à l'intervalle par
  // défaut (PUSH_POLL_INTERVAL_MS).
  const connection = app.get(getConnectionToken());
  await verifyPushIndexes(connection);
  const vapid = vapidPair();
  app.get(PushRuntime).activate(
    {
      enabled: true,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
      subject: 'mailto:charge@charge.local',
    },
    {
      async send(target, payload) {
        if (!isAllowedPushEndpoint(target.endpoint)) {
          return { statusCode: null, error: 'refused-endpoint' };
        }
        const body = JSON.parse(payload);
        fs.appendFileSync(
          L.PUSH_FILE,
          `${JSON.stringify({ t: Date.now(), tag: body.tag ?? null, category: body.category ?? body.data?.category ?? null })}\n`,
        );
        return { statusCode: 201 };
      },
    },
  );
  const dispatcher = app.get(PushDispatcherService);
  // 1-20B (expérience de mesure uniquement) : nombre de voies parallèles.
  const lanes = Number(process.env.LOAD_DISPATCH_LANES || '');
  if (Number.isInteger(lanes) && lanes >= 1 && 'dispatchLanes' in dispatcher) {
    dispatcher.dispatchLanes = lanes;
  }
  dispatcher.start();
  startStorageRecovery(app);

  // 1-20B (expérience de diagnostic uniquement, jamais en production) :
  // délai de conservation des connexions inactives du serveur HTTP.
  const keepAlive = Number(process.env.LOAD_KEEPALIVE_MS || '');
  if (Number.isInteger(keepAlive) && keepAlive > 0) {
    const server = app.getHttpServer();
    server.keepAliveTimeout = keepAlive;
    server.headersTimeout = keepAlive + 1000;
  }
  await app.listen(L.PORTS.api, L.HOST);
  startMetrics(connection, app.get(EventsGateway), countSignatures(app));
  watchProfileRequests();
  console.log(`API READY ${L.API_URL}`);
}

/**
 * Diagnostic : profil CPU à la demande (`cpu-profile.request` contenant
 * `{"seconds":N,"label":"x"}` dans le répertoire d'état), écrit en
 * `<label>.cpuprofile`. Inspecteur interne du processus, aucune route.
 */
function watchProfileRequests() {
  const path = require('path');
  const request = path.join(L.STATE_DIR, 'cpu-profile.request');
  let busy = false;
  const timer = setInterval(() => {
    if (busy || !fs.existsSync(request)) return;
    busy = true;
    let spec;
    try {
      spec = JSON.parse(fs.readFileSync(request, 'utf8'));
    } catch {
      spec = {};
    }
    fs.rmSync(request, { force: true });
    const inspector = require('inspector');
    const session = new inspector.Session();
    session.connect();
    session.post('Profiler.enable', () =>
      session.post('Profiler.setSamplingInterval', { interval: 500 }, () =>
        session.post('Profiler.start', () => {
          setTimeout(
            () => {
              session.post('Profiler.stop', (error, result) => {
                if (!error) {
                  fs.writeFileSync(
                    path.join(L.STATE_DIR, `${spec.label || 'api'}.cpuprofile`),
                    JSON.stringify(result.profile),
                  );
                }
                session.disconnect();
                busy = false;
              });
            },
            1000 * Math.min(60, Math.max(1, Number(spec.seconds) || 15)),
          );
        }),
      ),
    );
  }, 1000);
  timer.unref();
}

function vapidPair() {
  const ecdh = require('crypto').createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
}

/**
 * Mesures du processus API, une ligne par seconde. Pool MongoDB : sorties
 * et attentes du pool (événements CMAP du pilote), aucune commande ajoutée.
 */
/**
 * 1-20C — Signatures d'URL GET réellement calculées : intergiciel de
 * comptage ajouté au client de signature du `S3Service` (étape
 * `initialize`, commandes `GetObject` seulement : l'API ne télécharge
 * jamais d'objet, chaque `GetObject` est donc une pré-signature). Aucun
 * appel réseau ; identique pour le témoin et le nouveau code.
 */
function countSignatures(app) {
  const counter = { total: 0 };
  try {
    const { S3Service } = L.dist('s3/s3.service');
    const client = app.get(S3Service).signingClient;
    client.middlewareStack.add(
      (next, context) => (args) => {
        if (context.commandName === 'GetObjectCommand') counter.total += 1;
        return next(args);
      },
      { step: 'initialize', name: 'load1_20cSignatureCounter' },
    );
  } catch {
    counter.total = null;
  }
  return counter;
}

function startMetrics(connection, gateway, signatures = { total: null }) {
  let lastSignatures = signatures.total;
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const client = connection.getClient();
  const pool = {
    inUse: 0,
    maxInUse: 0,
    waits: [],
    failed: 0,
    created: 0,
  };
  const started = new Map();
  client.on('connectionCheckOutStarted', (e) => {
    const k = e.address;
    if (!started.has(k)) started.set(k, []);
    started.get(k).push(performance.now());
  });
  client.on('connectionCheckedOut', (e) => {
    const queue = started.get(e.address);
    const t0 = queue && queue.shift();
    if (t0 !== undefined) pool.waits.push(performance.now() - t0);
    pool.inUse += 1;
    pool.maxInUse = Math.max(pool.maxInUse, pool.inUse);
  });
  client.on('connectionCheckOutFailed', (e) => {
    const queue = started.get(e.address);
    if (queue) queue.shift();
    pool.failed += 1;
  });
  client.on('connectionCheckedIn', () => {
    pool.inUse = Math.max(0, pool.inUse - 1);
  });
  client.on('connectionCreated', () => {
    pool.created += 1;
  });

  let lastCpu = process.cpuUsage();
  let lastAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsedUs = (now - lastAt) * 1000;
    lastCpu = process.cpuUsage();
    lastAt = now;
    const mem = process.memoryUsage();
    const waits = pool.waits.sort((a, b) => a - b);
    const q = (p) =>
      waits.length
        ? waits[Math.min(waits.length - 1, Math.floor(p * waits.length))]
        : 0;
    let sockets = null;
    try {
      sockets = gateway.server.engine.clientsCount;
    } catch {
      // serveur Socket.IO pas encore prêt
    }
    const line = {
      t: Date.now(),
      cpuPct: Math.round(((cpu.user + cpu.system) / elapsedUs) * 1000) / 10,
      rssMb: Math.round(mem.rss / 2 ** 20),
      heapUsedMb: Math.round(mem.heapUsed / 2 ** 20),
      heapTotalMb: Math.round(mem.heapTotal / 2 ** 20),
      eldP50Ms: round(eld.percentile(50) / 1e6),
      eldP99Ms: round(eld.percentile(99) / 1e6),
      eldMaxMs: round(eld.max / 1e6),
      sockets,
      poolInUse: pool.inUse,
      poolMaxInUse: pool.maxInUse,
      poolCheckouts: waits.length,
      poolWaitP99Ms: round(q(0.99)),
      poolWaitMaxMs: round(waits.length ? waits[waits.length - 1] : 0),
      poolFailed: pool.failed,
      poolCreated: pool.created,
      signatures:
        signatures.total === null ? null : signatures.total - lastSignatures,
    };
    eld.reset();
    lastSignatures = signatures.total;
    pool.waits = [];
    pool.maxInUse = pool.inUse;
    try {
      fs.appendFileSync(L.METRICS_API, `${JSON.stringify(line)}\n`);
    } catch {
      // mesure facultative
    }
  }, 1000);
  timer.unref();
}

const round = (v) => Math.round(v * 10) / 10;

if (require.main === module) {
  main().catch((error) => {
    console.error(`API de charge interrompue : ${error && error.stack}`);
    process.exit(1);
  });
}
