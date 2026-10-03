/* eslint-disable */
// 1-14D.2E.1 — FIXTURE D'OBSERVATION RAILWAY (service de TEST isolé uniquement).
//
// Serveur Express minimal, INDÉPENDANT de l'application (aucune base, aucun
// module métier, aucune route de l'API). Il applique la confiance proxy avec
// le helper RÉELLEMENT livré (`dist/common/trust-proxy.js`, construit par
// `pnpm --filter api build`) et renvoie ce qu'il a reçu :
//   GET  /__observe  → socket, en-têtes de transfert, req.ip, req.ips,
//                      protocole, hostname (aucun cookie, jeton ni corps) ;
//   POST /__counter  → compteur à fenêtre fixe indexé sur `req.ip`
//                      (comme le tracker par défaut du throttler).
//
//   PROXY_OBSERVE_ENABLED=1 node test/proxy/railway-observe.js   (depuis api/)
//
// Garde-fous : refuse de démarrer sans PROXY_OBSERVE_ENABLED=1 ; aucune
// lecture de `X-Forwarded-For` hors d'Express ; jamais `trust proxy = true`
// (le helper le refuse). Ne JAMAIS déployer sur le service API de production.
'use strict';
const path = require('path');

const API_DIR = path.resolve(__dirname, '..', '..');
const helperPath =
  process.env.PROXY_OBSERVE_HELPER ||
  path.join(API_DIR, 'dist', 'common', 'trust-proxy.js');
const { resolveTrustProxySetting, applyTrustProxy } = require(helperPath);
const express = require(
  require.resolve('express', {
    paths: [
      path.dirname(
        require.resolve('@nestjs/platform-express', { paths: [API_DIR] }),
      ),
    ],
  }),
);

/** En-têtes dont la VALEUR est observée ; pour les autres, seul le NOM. */
const VALUE_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'forwarded',
  'via',
];
/** Jamais de valeur, même par erreur de configuration. */
const SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);
const PROBE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const COUNTER_LIMIT = Number.parseInt(
  process.env.OBSERVE_COUNTER_LIMIT || '5',
  10,
);
const COUNTER_WINDOW_MS = Number.parseInt(
  process.env.OBSERVE_COUNTER_WINDOW_MS || '300000',
  10,
);
if (!(COUNTER_LIMIT > 0) || !(COUNTER_WINDOW_MS > 0)) {
  throw new Error(
    'OBSERVE_COUNTER_LIMIT / OBSERVE_COUNTER_WINDOW_MS invalides.',
  );
}

function createObserveApp(
  env = process.env,
  log = (line) => process.stdout.write(line + '\n'),
) {
  const setting = resolveTrustProxySetting(env);
  const app = express();
  app.disable('x-powered-by');
  applyTrustProxy(app, setting);
  const counters = new Map();

  function observe(req) {
    const headers = {};
    for (const name of VALUE_HEADERS) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const probe =
      typeof req.query.probe === 'string' && PROBE_ID.test(req.query.probe)
        ? req.query.probe
        : null;
    return {
      at: new Date().toISOString(),
      probe,
      method: req.method,
      httpVersion: req.httpVersion,
      socket: req.socket.remoteAddress,
      socketFamily: req.socket.remoteFamily,
      localPort: req.socket.localPort,
      headers,
      headerNames: Object.keys(req.headers)
        .filter((n) => !SECRET_HEADERS.has(n))
        .sort(),
      ip: req.ip,
      ips: req.ips,
      protocol: req.protocol,
      hostname: req.hostname,
      trustProxy: setting,
    };
  }

  app.get('/__observe', (req, res) => {
    const record = observe(req);
    log(JSON.stringify({ kind: 'observe', ...record }));
    res.set('Cache-Control', 'no-store').json(record);
  });

  app.post('/__counter', (req, res) => {
    const now = Date.now();
    const key = req.ip; // même clé que le tracker par défaut ; jamais un en-tête brut
    let entry = counters.get(key);
    if (!entry || now - entry.start >= COUNTER_WINDOW_MS) {
      entry = { start: now, count: 0 };
      counters.set(key, entry);
    }
    entry.count += 1;
    const limited = entry.count > COUNTER_LIMIT;
    const record = {
      ...observe(req),
      counterKey: key,
      count: entry.count,
      limit: COUNTER_LIMIT,
      limited,
    };
    log(JSON.stringify({ kind: 'counter', ...record }));
    res
      .set('Cache-Control', 'no-store')
      .status(limited ? 429 : 200)
      .json(record);
  });

  app.use((req, res) => res.status(404).end());
  return { app, setting };
}

module.exports = { createObserveApp, VALUE_HEADERS };

if (require.main === module) {
  if (process.env.PROXY_OBSERVE_ENABLED !== '1') {
    process.stderr.write(
      'railway-observe: PROXY_OBSERVE_ENABLED=1 requis (fixture de test).\n',
    );
    process.exit(1);
  }
  const { app, setting } = createObserveApp();
  const port = Number.parseInt(process.env.PORT || '4000', 10);
  // `::` : double pile, nécessaire au réseau privé Railway (IPv6).
  app.listen(port, '::', () => {
    process.stdout.write(
      JSON.stringify({
        kind: 'start',
        port,
        trustProxy: setting,
        counterLimit: COUNTER_LIMIT,
      }) + '\n',
    );
  });
}
