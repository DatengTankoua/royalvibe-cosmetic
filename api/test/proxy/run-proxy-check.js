/* eslint-disable */
// 1-14D.2E — Harnais de validation RÉELLE du proxy (nginx → API).
//
//   node api/test/proxy/run-proxy-check.js        (depuis la racine du dépôt)
//
// Prérequis : Docker + Docker Compose v2.24+ (`!reset`/`!override`), openssl.
// Isolement :
// - projet Compose dédié `heyama_proxytest_14d2e` (réseaux et conteneurs
//   préfixés), aucun port publié sur l'hôte, aucun volume nommé ;
// - fichier d'environnement de TEST généré (valeurs aléatoires, jamais les
//   vrais `.env`) ; certificats auto-signés de test ;
// - démontage systématique (`down -v --remove-orphans`) et suppression de
//   l'image de test et du dossier temporaire.
// Aucune donnée réelle, aucun paiement, aucun email, aucun appel externe
// (hors construction de l'image : registre npm).
'use strict';
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROJECT = 'heyama_proxytest_14d2e';
const API_IMAGE = 'heyama-proxytest-api:14d2e';
const NGINX_EDGE = '172.31.250.2';
const CLIENT_A = '172.31.252.10';
const CLIENT_B = '172.31.252.11';
const ATTACKER_EDGE = '172.31.250.3';
const API_HOST = 'api.royalvibe.tondomaine.com';
const LOGIN_SHORT_LIMIT = 10;
const WEB_ORIGIN = 'https://royalvibe.tondomaine.com';
/** Forme IPv4 éventuellement mappée en IPv6 (`::ffff:a.b.c.d`) → IPv4. */
const ipv4 = (ip) => (typeof ip === 'string' ? ip.replace(/^::ffff:/, '') : ip);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heyama-proxytest-14d2e-'));
const certs = path.join(tmp, 'certs');
const observeDir = path.join(tmp, 'observe');
const envFile = path.join(tmp, 'test.env');
const observeFile = path.join(observeDir, 'requests.jsonl');
const results = [];
const keep = process.argv.includes('--keep-image');

function run(cmd, args, { allowFail = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && (!quiet || !allowFail)) {
    // Dernières lignes seulement ; jamais l'environnement de test.
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    process.stderr.write(`${tail}\n`);
  }
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} … → code ${r.status}`);
  }
  return r;
}

/**
 * Proxy de sortie de Docker Desktop (si configuré) : transmis UNIQUEMENT à la
 * construction via les arguments PRÉDÉFINIS HTTP(S)_PROXY (non conservés dans
 * l'historique de l'image) ; le Dockerfile et l'image sont inchangés.
 */
function buildProxyArgs() {
  const raw = run('docker', ['info', '--format', '{{json .}}'], {
    allowFail: true,
    quiet: true,
  }).stdout;
  let info = {};
  try {
    info = JSON.parse(raw);
  } catch {}
  const withScheme = (v) => (v && !/^[a-z]+:\/\//i.test(v) ? `http://${v}` : v);
  const args = [];
  if (info.HttpProxy) args.push('--build-arg', `HTTP_PROXY=${withScheme(info.HttpProxy)}`);
  if (info.HttpsProxy) args.push('--build-arg', `HTTPS_PROXY=${withScheme(info.HttpsProxy)}`);
  if (info.NoProxy) args.push('--build-arg', `NO_PROXY=${info.NoProxy}`);
  return args;
}

const composeArgs = [
  'compose',
  '-p', PROJECT,
  '-f', 'docker-compose.prod.yml',
  '-f', 'api/test/proxy/docker-compose.proxy-test.yml',
  '--env-file', envFile,
];
const compose = (args, opts) => run('docker', [...composeArgs, ...args], opts);

function check(id, title, condition, details) {
  results.push({ id, title, status: condition ? 'PASS' : 'FAIL', details });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${id} ${title}${details ? ' — ' + details : ''}`);
}

function observations() {
  if (!fs.existsSync(observeFile)) return [];
  return fs
    .readFileSync(observeFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Requêtes envoyées par un client conteneurisé ; observations associées. */
function client(service, options) {
  const before = observations().length;
  const r = compose(
    ['run', '--rm', '--no-deps', service, 'node', '/proxytest/client.js', JSON.stringify(options)],
    { quiet: true },
  );
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  // Laisse le temps à l'événement `finish` d'être écrit.
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  const obs = observations().slice(before).filter((o) => o.url !== '/health');
  return { ...out, obs };
}

function setup() {
  fs.mkdirSync(certs);
  fs.mkdirSync(observeDir);
  const sans = `subjectAltName=DNS:${API_HOST},DNS:royalvibe.tondomaine.com,DNS:s3.royalvibe.tondomaine.com`;
  run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${API_HOST}`, '-addext', sans,
    '-keyout', path.join(certs, 'privkey.pem'),
    '-out', path.join(certs, 'fullchain.pem'),
  ], { quiet: true });
  const random = () => crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(
    envFile,
    [
      'WEB_URL=https://royalvibe.tondomaine.com',
      `API_URL=https://${API_HOST}`,
      'MONGO_USER=proxytest',
      `MONGO_PASSWORD=${random()}`,
      'MINIO_USER=proxytest',
      `MINIO_PASSWORD=${random()}`,
      `JWT_SECRET=${random()}`,
      'S3_PUBLIC_URL=https://s3.royalvibe.tondomaine.com',
      'PUBLIC_APP_URL=https://royalvibe.tondomaine.com',
      'RESEND_API_KEY=',
      'EMAIL_FROM=',
      'PUBLIC_REGISTRATION_ENABLED=false',
      'NEXT_PUBLIC_REGISTRATION_ENABLED=false',
      `PROXYTEST_CERTS_DIR=${certs}`,
      `PROXYTEST_OBSERVE_DIR=${observeDir}`,
      '',
    ].join('\n'),
  );
}

function waitHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const id = compose(['ps', '-q', service], { quiet: true }).stdout.trim();
    if (id) {
      const state = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], {
        allowFail: true,
        quiet: true,
      }).stdout.trim();
      if (state === 'healthy') return true;
      if (state === 'unhealthy') return false;
    }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},3000)']);
  }
  return false;
}

function scenarios() {
  // ── Configuration Compose (sans afficher de secret) ────────────────────
  const config = JSON.parse(compose(['config', '--format', 'json'], { quiet: true }).stdout);
  const api = config.services.api;
  check('0', 'API sans port publié ; confiance = adresse fixe de nginx',
    !api.ports && api.environment.TRUST_PROXY_ADDRESSES === NGINX_EDGE &&
      api.environment.TRUST_PROXY_HOPS === undefined &&
      config.services.nginx.networks.edge.ipv4_address === NGINX_EDGE &&
      JSON.stringify(api.networks.edge.aliases) === '["api-edge"]',
    `TRUST_PROXY_ADDRESSES=${api.environment.TRUST_PROXY_ADDRESSES}`);

  // ── nginx -t sur la configuration réelle ────────────────────────────────
  const t = compose(['exec', '-T', 'nginx', 'nginx', '-t'], { allowFail: true, quiet: true });
  check('1', 'nginx -t (nginx.conf réel)', t.status === 0, (t.stderr || '').trim().split('\n').pop());

  const nginx = (count, headers, extra = {}) => ({
    target: 'nginx', host: '172.31.252.2', port: 443, count, headers, ...extra,
  });

  // ── Adresse cliente attendue via nginx ──────────────────────────────────
  const plain = client('client-a', nginx(1, [{}]));
  const o = plain.obs[0] || {};
  check('2', 'Via nginx : req.ip = adresse source réelle du client',
    o.ip === CLIENT_A && o.socket.endsWith(NGINX_EDGE) && o.xForwardedFor === CLIENT_A &&
      o.xRealIp === CLIENT_A && o.protocol === 'https' && o.hostname === API_HOST &&
      o.forwarded === null && o.trustProxy === NGINX_EDGE,
    JSON.stringify({ ip: o.ip, socket: o.socket, xff: o.xForwardedFor, proto: o.protocol, host: o.hostname }));

  // ── En-têtes forgés via nginx ───────────────────────────────────────────
  const forged = client('client-a', nginx(3, [
    { 'X-Forwarded-For': '203.0.113.9' },
    { 'X-Forwarded-For': '198.51.100.1, 198.51.100.2' },
    {
      'X-Real-IP': '203.0.113.9', Forwarded: 'for=203.0.113.9;proto=http',
      'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'evil.example',
    },
  ]));
  check('3', 'XFF/X-Real-IP/Forwarded/Proto/Host forgés : écrasés par nginx, req.ip inchangé',
    forged.obs.length === 3 && forged.obs.every((x) =>
      x.ip === CLIENT_A && x.xForwardedFor === CLIENT_A && x.xRealIp === CLIENT_A &&
      x.forwarded === null && x.protocol === 'https' && x.hostname === API_HOST),
    JSON.stringify(forged.obs.map((x) => x.xForwardedFor)));

  // ── Limitation : A limité malgré des XFF changeants ─────────────────────
  // A a déjà 4 tentatives ; 8 de plus : tentatives 5–10 → 401, 11–12 → 429.
  const burst = client('client-a', nginx(8, Array.from({ length: 8 }, (_, i) => ({
    'X-Forwarded-For': i % 2 ? `198.51.100.${i}, 203.0.113.${i}` : `203.0.113.${i + 100}`,
  }))));
  check('4', 'A limité (429) malgré des XFF forgés changeants',
    JSON.stringify(burst.statuses) === JSON.stringify([401, 401, 401, 401, 401, 401, 429, 429]) &&
      burst.codes.slice(6).every((c) => c === 'AUTH_RATE_LIMITED'),
    JSON.stringify(burst.statuses));

  const b = client('client-b', nginx(1, [{}]));
  check('5', 'B (adresse source distincte) toujours autorisé',
    b.statuses[0] === 401 && b.obs[0] && b.obs[0].ip === CLIENT_B, JSON.stringify(b.statuses));

  const aAgain = client('client-a', nginx(2, [
    { 'X-Forwarded-For': CLIENT_B }, { 'X-Forwarded-For': '192.0.2.200' },
  ]));
  check('6', 'Changer les en-têtes forgés ne réinitialise pas la limite de A',
    aAgain.statuses.every((s) => s === 429) && aAgain.obs.every((x) => x.ip === CLIENT_A),
    JSON.stringify(aAgain.statuses));

  // ── Accès direct (sans nginx) : aucune usurpation ───────────────────────
  const direct = client('attacker-default', {
    target: 'direct', host: 'api', port: 4000, count: LOGIN_SHORT_LIMIT + 1,
    headers: [{ 'X-Forwarded-For': CLIENT_B, 'X-Real-IP': CLIENT_B }],
  });
  const directIps = [...new Set(direct.obs.map((x) => x.ip))];
  check('7a', 'Accès direct (réseau default) : XFF ignoré, compteur propre à l’attaquant',
    directIps.length === 1 && directIps[0] !== CLIENT_B && !directIps[0].startsWith('172.31.252.') &&
      direct.statuses[LOGIN_SHORT_LIMIT] === 429 &&
      direct.obs.every((x) => x.xForwardedFor === CLIENT_B),
    `req.ip=${directIps.join(',')} ; ${JSON.stringify(direct.statuses.slice(-2))}`);
  const bAfter = client('client-b', nginx(1, [{}]));
  check('7b', 'B non pénalisé par l’attaquant qui usurpait son adresse',
    bAfter.statuses[0] === 401, JSON.stringify(bAfter.statuses));

  const edge = client('attacker-edge', {
    target: 'direct', host: 'api-edge', port: 4000, count: 1,
    headers: [{ 'X-Forwarded-For': '203.0.113.50' }],
  });
  check('7c', 'Accès direct depuis edge (adresse ≠ nginx) : non approuvé',
    edge.obs[0] && ipv4(edge.obs[0].ip) === ATTACKER_EDGE &&
      edge.obs[0].xForwardedFor === '203.0.113.50',
    edge.obs[0] && edge.obs[0].ip);

  // ── WebSocket : en-têtes Upgrade/Connection conservés ───────────────────
  // `Origin` autorisée requise par la politique Socket.IO existante
  // (`allowRequest`) : sans elle, 400 quel que soit le proxy.
  const ws = client('client-b', nginx(1, [{ Origin: WEB_ORIGIN }], {
    mode: 'upgrade', path: '/socket.io/?EIO=4&transport=websocket',
  }));
  check('8', 'WebSocket via nginx : upgrade 101 (Upgrade/Connection conservés)',
    ws.statuses[0] === 101, JSON.stringify(ws.statuses));
  const wsNoOrigin = client('client-b', nginx(1, [{}], {
    mode: 'upgrade', path: '/socket.io/?EIO=4&transport=websocket',
  }));
  check('8b', 'Contrôle : sans Origin autorisée, refus applicatif inchangé (400)',
    wsNoOrigin.statuses[0] === 400, JSON.stringify(wsNoOrigin.statuses));

  // ── Appels internes (healthcheck Docker) ────────────────────────────────
  const health = observations().filter((x) => x.url === '/health');
  check('9', 'Healthcheck interne : req.ip = 127.0.0.1 (aucune usurpation possible)',
    health.length > 0 && health.every((x) => /^(::ffff:)?127\.0\.0\.1$/.test(x.ip)),
    `${health.length} contrôle(s)`);
}

let exitCode = 1;
try {
  setup();
  compose(['config', '--quiet']);
  console.log('Construction de l’image API réelle (api/Dockerfile)…');
  compose(['build', ...buildProxyArgs(), 'api'], { quiet: true });
  compose(['up', '-d', 'mongo', 'minio', 'web', 'api', 'nginx'], { quiet: true });
  if (!waitHealthy('api', 240_000)) throw new Error('API non saine dans le délai');
  scenarios();
  exitCode = results.every((r) => r.status === 'PASS') ? 0 : 1;
  console.log(`\n${results.filter((r) => r.status === 'PASS').length}/${results.length} PASS`);
} catch (error) {
  console.error('ÉCHEC du harnais :', error.message);
  try {
    const logs = compose(['logs', '--no-color', '--tail', '40', 'api', 'nginx'], { allowFail: true, quiet: true });
    console.error(logs.stdout.replace(/(PASSWORD|SECRET|mongodb:\/\/)[^\s]*/gi, '$1…'));
  } catch {}
} finally {
  compose(['--profile', 'clients', 'down', '-v', '--remove-orphans'], { allowFail: true, quiet: true });
  if (!keep) run('docker', ['image', 'rm', '-f', API_IMAGE], { allowFail: true, quiet: true });
  fs.writeFileSync(path.join(os.tmpdir(), 'heyama-proxytest-14d2e-results.json'), JSON.stringify(results, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
