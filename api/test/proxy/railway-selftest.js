/* eslint-disable */
// 1-14D.2E.1 — AUTO-TEST LOCAL de l'outillage Railway (fixture, sonde, analyse).
//
//   node api/test/proxy/railway-selftest.js      (après `pnpm --filter api build`)
//
// Tout tourne sur 127.0.0.1, sans réseau externe, base ni service métier.
// Deux « proxys d'entrée » locaux simulent l'edge Railway pour deux clients
// (adresses de documentation 192.0.2.10 / .11) : mode `append` (ajoute le
// client à la fin de X-Forwarded-For) et mode `overwrite`. Un accès direct à
// la fixture simule un chemin qui contourne l'entrée HTTP.
//
// Ce test valide l'OUTILLAGE et la logique de décision. Il ne dit RIEN du
// comportement réel de Railway.
'use strict';
const assert = require('assert');
const http = require('http');
const { createObserveApp } = require('./railway-observe');
const { probe } = require('./railway-probe');
const { analyze, format } = require('./railway-analyze');

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

/** Proxy d'entrée simulé : `append` (style courant) ou `overwrite`. */
function edgeProxy(targetPort, clientIp, mode) {
  return http.createServer((req, res) => {
    const headers = { ...req.headers };
    const prior = headers['x-forwarded-for'];
    headers['x-forwarded-for'] =
      mode === 'append' && prior ? `${prior}, ${clientIp}` : clientIp;
    headers['x-forwarded-proto'] = 'https';
    const up = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
}

async function scenario({ trustHops, mode, withBypass }) {
  const env = trustHops ? { TRUST_PROXY_HOPS: String(trustHops) } : {};
  const { app } = createObserveApp(env, () => {});
  const fixture = http.createServer(app);
  const fixturePort = await listen(fixture);
  const proxyA = edgeProxy(fixturePort, '192.0.2.10', mode);
  const proxyB = edgeProxy(fixturePort, '192.0.2.11', mode);
  const portA = await listen(proxyA);
  const portB = await listen(proxyB);
  try {
    const results = [
      await probe({
        base: `http://127.0.0.1:${portA}`,
        label: 'A',
        pathKind: 'local',
        egressIp: '192.0.2.10',
        counter: true,
        counterRequests: 8,
      }),
      await probe({
        base: `http://127.0.0.1:${portB}`,
        label: 'B',
        pathKind: 'local',
        egressIp: '192.0.2.11',
        counter: true,
        counterRequests: 1,
      }),
    ];
    // Les deux proxys simulent la MÊME entrée (un domaine, deux clients) ;
    // seuls leurs ports locaux diffèrent.
    for (const r of results) r.host = 'simulated-edge';
    if (withBypass) {
      results.push(
        await probe({
          base: `http://127.0.0.1:${fixturePort}`,
          label: 'direct',
          pathKind: 'private',
          counter: false,
        }),
      );
    }
    return { results, report: analyze(results) };
  } finally {
    for (const s of [proxyA, proxyB, fixture]) s.close();
  }
}

const verdict = (report, name) =>
  report.verdicts.find((v) => v.candidate === name).status;
const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push(`✓ ${name}`);
  } catch (e) {
    checks.push(`✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  await check(
    'fixture sans confiance : req.ip = socket, en-têtes forgés ignorés, compteur partagé',
    async () => {
      const { results, report } = await scenario({
        trustHops: 0,
        mode: 'append',
      });
      assert.deepStrictEqual(report.problems, []);
      for (const o of results[0].observations)
        assert.strictEqual(o.observed.ip.replace(/^::ffff:/, ''), '127.0.0.1');
      assert.strictEqual(verdict(report, 'none'), 'sûr mais compteur partagé');
      const [cA, cB] = report.counters;
      assert.strictEqual(cA.distinctKeys, 1);
      assert.strictEqual(cA.bypassed, false);
      assert.ok(cB.firstCount > 1, 'B partage le compteur de A (même req.ip)');
    },
  );

  await check(
    'edge `append`, un seul chemin : HOPS=1 conforme et seul retenu, HOPS=2 rejeté',
    async () => {
      const { report } = await scenario({ trustHops: 1, mode: 'append' });
      assert.deepStrictEqual(report.problems, []);
      assert.deepStrictEqual(report.coverage, []);
      assert.strictEqual(verdict(report, 'TRUST_PROXY_HOPS=1'), 'conforme');
      assert.strictEqual(verdict(report, 'TRUST_PROXY_HOPS=2'), 'rejeté');
      assert.strictEqual(report.recommendation, 'TRUST_PROXY_HOPS=1');
      const [cA, cB] = report.counters;
      assert.strictEqual(
        cA.distinctKeys,
        1,
        'X-Forwarded-For changeant ne change pas la clé',
      );
      assert.strictEqual(cA.bypassed, false);
      assert.ok(cA.limitedAt >= 0, 'A atteint 429');
      assert.strictEqual(
        cB.firstCount,
        1,
        'compteur de B séparé de celui de A',
      );
    },
  );

  await check(
    'edge `overwrite` : HOPS=1 retenu (le plus strict des réglages équivalents)',
    async () => {
      const { report } = await scenario({ trustHops: 1, mode: 'overwrite' });
      assert.strictEqual(verdict(report, 'TRUST_PROXY_HOPS=1'), 'conforme');
      assert.strictEqual(verdict(report, 'TRUST_PROXY_HOPS=2'), 'conforme');
      assert.strictEqual(report.recommendation, 'TRUST_PROXY_HOPS=1');
    },
  );

  await check(
    "chemin contournant l'entrée : HOPS=1 rejeté, aucune recommandation",
    async () => {
      const { report } = await scenario({
        trustHops: 0,
        mode: 'append',
        withBypass: true,
      });
      assert.strictEqual(verdict(report, 'TRUST_PROXY_HOPS=1'), 'rejeté');
      assert.ok(
        report.verdicts[1].failures.some((f) => f.startsWith('direct/')),
      );
      assert.strictEqual(report.recommendation, null);
      process.stdout.write(format(report).replace(/^/gm, '    | ') + '\n');
    },
  );

  await check(
    'couverture Railway incomplète signalée (un seul client, chemins non déclarés)',
    async () => {
      const { results } = await scenario({ trustHops: 0, mode: 'append' });
      const railwayLike = [{ ...results[0], pathKind: 'railway-domain' }];
      const report = analyze(railwayLike);
      assert.ok(report.coverage.some((c) => c.includes('deux clients')));
      assert.ok(report.coverage.some((c) => c.includes('privé')));
      assert.ok(report.coverage.some((c) => c.includes('TCP')));
      assert.ok(report.coverage.some((c) => c.includes('personnalisé')));
      assert.strictEqual(report.recommendation, null);
    },
  );

  await check(
    'la fixture refuse `trust proxy = true` et une plage (helper livré)',
    async () => {
      assert.throws(() =>
        createObserveApp({ TRUST_PROXY_HOPS: 'true' }, () => {}),
      );
      assert.throws(() =>
        createObserveApp({ TRUST_PROXY_ADDRESSES: '10.0.0.0/8' }, () => {}),
      );
    },
  );

  process.stdout.write(
    checks.join('\n') +
      `\n${checks.filter((c) => c.startsWith('✓')).length}/${checks.length} vérifications\n`,
  );
})();
