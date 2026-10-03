/* eslint-disable */
// 1-14D.2E.1 — SONDE de la fixture `railway-observe.js` (cible de TEST uniquement).
//
//   node api/test/proxy/railway-probe.js --base <url> --label <A|B|…> \
//        --path-kind <railway-domain|custom-domain|private|tcp> \
//        [--egress-ip <adresse publique de sortie>] [--ip-family 4|6] [--counter] --out <fichier.json>
//
// Envoie des requêtes ordinaires puis forgées (en-têtes seuls et en liste)
// vers /__observe, et, avec --counter, une rafale vers /__counter avec des
// `X-Forwarded-For` changants. N'envoie ni jeton, ni cookie, ni corps métier.
// Les adresses forgées sont des adresses de documentation (RFC 5737).
// Refuse toute URL qui n'est pas la fixture (chemins fixes /__observe, /__counter).
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');

const FORGED = {
  single: '198.51.100.7',
  list: ['198.51.100.7', '198.51.100.8'],
  realIp: '198.51.100.9',
  forwardedFor: '198.51.100.10',
  rotating: (i) => `203.0.113.${(i % 200) + 20}`,
};

const SCENARIOS = [
  { name: 'plain', headers: {} },
  { name: 'xff-single', headers: { 'x-forwarded-for': FORGED.single } },
  { name: 'xff-list', headers: { 'x-forwarded-for': FORGED.list.join(', ') } },
  { name: 'x-real-ip', headers: { 'x-real-ip': FORGED.realIp } },
  {
    name: 'forwarded',
    headers: {
      forwarded: `for=${FORGED.forwardedFor};proto=http;host=forged.invalid`,
    },
  },
  {
    name: 'proto-host',
    headers: {
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'forged.invalid',
    },
  },
  {
    name: 'all-forged',
    headers: {
      'x-forwarded-for': FORGED.list.join(', '),
      'x-real-ip': FORGED.realIp,
      forwarded: `for=${FORGED.forwardedFor}`,
      'x-forwarded-proto': 'http',
      'x-forwarded-host': 'forged.invalid',
    },
  },
];

const PATH_KINDS = new Set([
  'railway-domain',
  'custom-domain',
  'private',
  'tcp',
  'local',
]);

function parseArgs(argv) {
  const args = { counter: false, counterRequests: 8, insecure: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a}: valeur manquante`);
      return argv[++i];
    };
    if (a === '--base') args.base = next();
    else if (a === '--label') args.label = next();
    else if (a === '--path-kind') args.pathKind = next();
    else if (a === '--egress-ip') args.egressIp = next();
    else if (a === '--out') args.out = next();
    else if (a === '--ip-family') args.ipFamily = Number.parseInt(next(), 10);
    else if (a === '--counter') args.counter = true;
    else if (a === '--counter-requests')
      args.counterRequests = Number.parseInt(next(), 10);
    else throw new Error(`argument inconnu : ${a}`);
  }
  if (!args.base || !args.label || !args.pathKind) {
    throw new Error('--base, --label et --path-kind sont obligatoires');
  }
  if (!PATH_KINDS.has(args.pathKind))
    throw new Error(`--path-kind invalide : ${args.pathKind}`);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(args.label))
    throw new Error('--label invalide');
  const url = new URL(args.base);
  if (url.pathname !== '/' || url.search || url.username || url.password) {
    throw new Error(
      '--base doit être une origine (schéma://hôte[:port]) sans chemin ni identifiants',
    );
  }
  if (args.ipFamily !== undefined && args.ipFamily !== 4 && args.ipFamily !== 6)
    throw new Error('--ip-family doit valoir 4 ou 6');
  return args;
}

function request(args, method, path, headers) {
  const url = new URL(path, args.base);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: { accept: 'application/json', ...headers },
        timeout: 15000,
        ...(args.ipFamily ? { family: args.ipFamily } : {}),
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 64 * 1024)
            req.destroy(new Error('réponse trop grande'));
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* réponse non JSON : pas la fixture */
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
    req.end();
  });
}

async function probe(args) {
  const runId = `${args.label}-${Date.now().toString(36)}`;
  const observations = [];
  for (const scenario of SCENARIOS) {
    const r = await request(
      args,
      'GET',
      `/__observe?probe=${runId}.${scenario.name}`,
      scenario.headers,
    );
    if (r.status !== 200 || !r.json || !('socket' in r.json)) {
      throw new Error(
        `${scenario.name}: réponse inattendue (${r.status}) — la cible n'est pas la fixture`,
      );
    }
    observations.push({
      scenario: scenario.name,
      sent: scenario.headers,
      observed: r.json,
    });
  }
  let counter = null;
  if (args.counter) {
    counter = [];
    for (let i = 0; i < args.counterRequests; i += 1) {
      const sent = i === 0 ? {} : { 'x-forwarded-for': FORGED.rotating(i) };
      const r = await request(
        args,
        'POST',
        `/__counter?probe=${runId}.counter${i}`,
        sent,
      );
      if (!r.json || !('count' in r.json))
        throw new Error(`counter ${i}: réponse inattendue (${r.status})`);
      counter.push({
        i,
        sent,
        status: r.status,
        count: r.json.count,
        limit: r.json.limit,
        key: r.json.counterKey,
      });
    }
  }
  return {
    version: 1,
    lot: '1-14D.2E.1',
    at: new Date().toISOString(),
    label: args.label,
    pathKind: args.pathKind,
    host: new URL(args.base).host,
    egressIp: args.egressIp || null,
    ipFamily: args.ipFamily || null,
    forged: { ...FORGED, rotating: 'TEST-NET-3 203.0.113.20-219' },
    observations,
    counter,
  };
}

module.exports = { probe, parseArgs, SCENARIOS, FORGED };

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`railway-probe: ${e.message}\n`);
    process.exit(64);
  }
  probe(args).then(
    (result) => {
      const text = JSON.stringify(result, null, 2);
      if (args.out) fs.writeFileSync(args.out, text + '\n');
      else process.stdout.write(text + '\n');
      process.stderr.write(
        `railway-probe: ${result.observations.length} observations${args.out ? ` → ${args.out}` : ''}\n`,
      );
    },
    (e) => {
      process.stderr.write(`railway-probe: ${e.message}\n`);
      process.exit(1);
    },
  );
}
