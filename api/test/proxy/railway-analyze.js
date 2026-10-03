/* eslint-disable */
// 1-14D.2E.1 — ANALYSE hors ligne des résultats de `railway-probe.js`.
//
//   node api/test/proxy/railway-analyze.js <résultat.json>… \
//        [--declare-no-private] [--declare-no-tcp] [--declare-no-custom-domain]
//
// Recalcule, pour chaque observation brute (socket + X-Forwarded-For reçus),
// le `req.ip` qu'Express produirait avec chaque réglage candidat — aucun
// (défaut), TRUST_PROXY_HOPS=1, 2, 3 — via `proxy-addr`, la bibliothèque
// qu'utilise Express. Les adresses de proxy ne sont JAMAIS proposées :
// une adresse observée n'est pas une adresse fixe garantie.
//
// Un réglage n'est retenu que si, sur TOUS les chemins fournis :
// - chemins publics : chaque scénario (ordinaire ou forgé) donne l'adresse
//   de sortie déclarée du client, et deux clients distincts restent distincts ;
// - chemins privés / TCP : aucun scénario ne donne une adresse forgée ;
// et si la couverture est complète (deux clients par domaine public, chemins
// privé / TCP / domaine personnalisé sondés ou explicitement déclarés absents).
// Code de sortie : 0 = un réglage justifié ; 2 = aucun ; 64 = usage.
'use strict';
const fs = require('fs');
const path = require('path');

const API_DIR = path.resolve(__dirname, '..', '..');
const expressDir = path.dirname(
  require.resolve('express', {
    paths: [
      path.dirname(
        require.resolve('@nestjs/platform-express', { paths: [API_DIR] }),
      ),
    ],
  }),
);
const proxyaddr = require(
  require.resolve('proxy-addr', { paths: [expressDir] }),
);

const CANDIDATES = [
  { name: 'none', hops: 0 },
  { name: 'TRUST_PROXY_HOPS=1', hops: 1 },
  { name: 'TRUST_PROXY_HOPS=2', hops: 2 },
  { name: 'TRUST_PROXY_HOPS=3', hops: 3 },
];
const PUBLIC_KINDS = new Set(['railway-domain', 'custom-domain', 'local']);

const norm = (ip) =>
  typeof ip === 'string' ? ip.replace(/^::ffff:/i, '') : ip;

/** `req.ip` qu'Express calculerait (même compilation que `trust proxy = n`). */
function resolveIp(socket, xff, hops) {
  const fakeReq = {
    socket: { remoteAddress: socket },
    connection: { remoteAddress: socket },
    headers: xff == null ? {} : { 'x-forwarded-for': xff },
  };
  return proxyaddr(fakeReq, (_addr, i) => i < hops);
}

function forgedSet(result) {
  const f = result.forged;
  const set = new Set([f.single, ...f.list, f.realIp, f.forwardedFor]);
  for (let i = 20; i < 220; i += 1) set.add(`203.0.113.${i}`);
  return set;
}

function activeHops(trust) {
  if (!trust || trust.mode === 'none') return 0;
  if (trust.mode === 'hops') return trust.hops;
  return null; // mode adresses : non recalculé ici
}

function analyze(results, declared = {}) {
  const problems = [];
  const coverage = [];

  // Cohérence : le recalcul hors ligne doit reproduire le req.ip observé.
  for (const r of results) {
    for (const o of r.observations) {
      const hops = activeHops(o.observed.trustProxy);
      if (hops === null) continue;
      const xff = o.observed.headers['x-forwarded-for'] ?? null;
      const computed = resolveIp(o.observed.socket, xff, hops);
      if (norm(computed) !== norm(o.observed.ip)) {
        problems.push(
          `${r.label}/${o.scenario}: recalcul ${computed} ≠ req.ip observé ${o.observed.ip}`,
        );
      }
    }
  }

  // Couverture.
  const publicHosts = new Map();
  for (const r of results.filter((x) => PUBLIC_KINDS.has(x.pathKind))) {
    const key = `${r.pathKind} ${r.host}`;
    if (!publicHosts.has(key)) publicHosts.set(key, []);
    publicHosts.get(key).push(r);
    if (!r.egressIp)
      coverage.push(
        `${r.label} (${key}) : adresse de sortie non déclarée (--egress-ip)`,
      );
  }
  if (publicHosts.size === 0) coverage.push('aucun chemin public sondé');
  for (const [key, rs] of publicHosts) {
    const egress = new Set(rs.map((r) => r.egressIp).filter(Boolean));
    if (egress.size < 2)
      coverage.push(
        `${key} : il faut deux clients aux adresses de sortie distinctes (${egress.size})`,
      );
  }
  const kinds = new Set(results.map((r) => r.pathKind));
  if (!kinds.has('local')) {
    if (!kinds.has('custom-domain') && !declared.noCustomDomain)
      coverage.push('domaine personnalisé ni sondé ni déclaré absent');
    if (!kinds.has('private') && !declared.noPrivate)
      coverage.push(
        'chemin privé (railway.internal) ni sondé ni déclaré absent',
      );
    if (!kinds.has('tcp') && !declared.noTcp)
      coverage.push('proxy TCP ni sondé ni déclaré absent');
  }

  // Candidats.
  const verdicts = CANDIDATES.map((c) => {
    const failures = [];
    let collapsed = false;
    for (const r of results) {
      const forged = forgedSet(r);
      const resolved = r.observations.map((o) => ({
        scenario: o.scenario,
        ip: norm(
          resolveIp(
            o.observed.socket,
            o.observed.headers['x-forwarded-for'] ?? null,
            c.hops,
          ),
        ),
      }));
      for (const x of resolved) {
        if (forged.has(x.ip))
          failures.push(
            `${r.label}/${x.scenario} : adresse forgée acceptée (${x.ip})`,
          );
      }
      if (PUBLIC_KINDS.has(r.pathKind)) {
        const distinct = new Set(resolved.map((x) => x.ip));
        if (distinct.size > 1)
          failures.push(
            `${r.label} : req.ip varie selon les en-têtes envoyés (${[...distinct].join(', ')})`,
          );
        if (r.egressIp && resolved[0].ip !== norm(r.egressIp)) {
          // Sans proxy approuvé, req.ip = proxy d'entrée : sûr mais regroupé.
          if (c.hops === 0) collapsed = true;
          else
            failures.push(
              `${r.label} : req.ip ${resolved[0].ip} ≠ sortie déclarée ${r.egressIp}`,
            );
        }
      }
    }
    for (const [key, rs] of publicHosts) {
      const plain = rs
        .filter((r) => r.egressIp)
        .map((r) => ({
          egress: norm(r.egressIp),
          ip: norm(
            resolveIp(
              r.observations[0].observed.socket,
              r.observations[0].observed.headers['x-forwarded-for'] ?? null,
              c.hops,
            ),
          ),
        }));
      for (let i = 0; i < plain.length; i += 1) {
        for (let j = i + 1; j < plain.length; j += 1) {
          if (
            plain[i].egress !== plain[j].egress &&
            plain[i].ip === plain[j].ip
          ) {
            if (c.hops === 0) collapsed = true;
            else
              failures.push(
                `${key} : deux clients distincts partagent req.ip ${plain[i].ip}`,
              );
          }
        }
      }
    }
    const status = failures.length
      ? 'rejeté'
      : collapsed
        ? 'sûr mais compteur partagé'
        : 'conforme';
    return {
      candidate: c.name,
      hops: c.hops,
      status,
      failures: [...new Set(failures)],
    };
  });

  // Compteurs (réglage ACTIF de la fixture au moment de la sonde).
  const counters = results
    .filter((r) => Array.isArray(r.counter))
    .map((r) => {
      const keys = new Set(r.counter.map((x) => x.key));
      const limit = r.counter[0].limit;
      const firstLimited = r.counter.findIndex((x) => x.status === 429);
      return {
        label: r.label,
        host: r.host,
        active: r.observations[0].observed.trustProxy,
        distinctKeys: keys.size,
        firstCount: r.counter[0].count,
        limitedAt: firstLimited,
        // Contourné si les en-têtes changent la clé, ou si la limite est
        // franchie sans qu'aucune 429 ne soit renvoyée.
        bypassed:
          keys.size > 1 ||
          (r.counter[0].count - 1 + r.counter.length > limit &&
            firstLimited === -1),
      };
    });

  // Plusieurs nombres de sauts peuvent être équivalents sur les données (proxy
  // qui ÉCRASE l'en-tête) : on retient le plus petit, le plus strict.
  const conforming = verdicts.filter(
    (v) => v.status === 'conforme' && v.hops > 0,
  );
  const recommendation =
    problems.length === 0 && coverage.length === 0 && conforming.length > 0
      ? conforming[0].candidate
      : null;
  return { problems, coverage, verdicts, counters, recommendation };
}

function format(report) {
  const out = [];
  out.push('== Cohérence du recalcul');
  out.push(
    report.problems.length
      ? report.problems.map((p) => `  ✗ ${p}`).join('\n')
      : '  ✓ req.ip observé = req.ip recalculé',
  );
  out.push('== Couverture');
  out.push(
    report.coverage.length
      ? report.coverage.map((p) => `  ✗ ${p}`).join('\n')
      : '  ✓ complète',
  );
  out.push('== Réglages candidats');
  for (const v of report.verdicts) {
    out.push(
      `  ${v.status === 'rejeté' ? '✗' : '✓'} ${v.candidate} : ${v.status}`,
    );
    for (const f of v.failures) out.push(`      - ${f}`);
  }
  if (report.counters.length) {
    out.push('== Compteurs (réglage actif de la fixture)');
    for (const c of report.counters) {
      out.push(
        `  ${c.bypassed ? '✗' : '✓'} ${c.label}@${c.host} [${JSON.stringify(c.active)}] clés=${c.distinctKeys} 1er compte=${c.firstCount} 429 à l'essai #${c.limitedAt}`,
      );
    }
  }
  out.push('== Conclusion');
  out.push(
    report.recommendation
      ? `  Réglage justifié par ces mesures : ${report.recommendation}`
      : '  Aucun réglage justifié : conserver le défaut (aucun proxy approuvé).',
  );
  return out.join('\n');
}

module.exports = { analyze, format, resolveIp };

if (require.main === module) {
  const files = [];
  const declared = {};
  for (const a of process.argv.slice(2)) {
    if (a === '--declare-no-private') declared.noPrivate = true;
    else if (a === '--declare-no-tcp') declared.noTcp = true;
    else if (a === '--declare-no-custom-domain') declared.noCustomDomain = true;
    else if (a.startsWith('--')) {
      process.stderr.write(`argument inconnu : ${a}\n`);
      process.exit(64);
    } else files.push(a);
  }
  if (!files.length) {
    process.stderr.write(
      'usage : railway-analyze.js <résultat.json>… [--declare-no-private] [--declare-no-tcp] [--declare-no-custom-domain]\n',
    );
    process.exit(64);
  }
  const report = analyze(
    files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))),
    declared,
  );
  process.stdout.write(format(report) + '\n');
  process.exit(report.recommendation ? 0 : 2);
}
