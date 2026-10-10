/**
 * 1-20A — Parcours HTTP de Stock Master pour Grafana k6 (TEST, local).
 *
 *   k6 run -e SCENARIO=catalog -e VUS=10 -e DURATION=45s \
 *          -e SESSIONS=<state>/sessions.json -e SUMMARY_OUT=<f.json> \
 *          api/test/load/k6/stockmaster.js
 *
 * Variables :
 * - SCENARIO : catalog | dashboard | sales | products | notifications | mixed
 * - TARGET   : multi (toutes les entreprises, défaut) | concentrated
 *              (une entreprise, plusieurs vendeurs)
 * - VUS, DURATION, PACE_S (durée visée d'une itération ; débit OFFERT =
 *   VUS / PACE_S itérations/s), THINK=1 (pauses réalistes, mixte)
 * - BASE_URL : refusée si l'hôte n'est pas local ou le port ≠ 4300.
 *
 * Les sessions sont préparées AVANT la mesure (`load-seed.js`) : aucun login
 * n'est mesuré à chaque requête. Plusieurs utilisateurs virtuels peuvent
 * partager une session (onglets d'un même utilisateur).
 *
 * Classement des réponses :
 * - `unexpected_errors` : 5xx, réseau, délai dépassé, 4xx non prévu ;
 * - `business_refusals` : refus métier prévus (stock insuffisant…) ;
 * - `rate_limited` : 429 (attendus seulement sur les routes limitées).
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4300';
(function guard() {
  const m = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d+)(\/|$)/.exec(
    BASE_URL,
  );
  if (!m || m[2] !== '4300') {
    throw new Error(
      `Charge refusée : cible non locale ou port inattendu (${BASE_URL}).`,
    );
  }
})();

const SCENARIO = __ENV.SCENARIO || 'catalog';
const TARGET = __ENV.TARGET || 'multi';
const VUS = Number(__ENV.VUS || 1);
const DURATION = __ENV.DURATION || '30s';
const PACE_S = Number(__ENV.PACE_S || 1);
const THINK = __ENV.THINK === '1';
const TIMEOUT = __ENV.TIMEOUT || '10s';

const data = new SharedArray('stack', () => {
  const parsed = JSON.parse(open(__ENV.SESSIONS));
  return [parsed];
})[0];

const ROUTES = [
  'sections_list',
  'products_list',
  'products_by_section',
  'product_detail',
  'analytics_overview',
  'analytics_monthly',
  'analytics_insights',
  'sales_history',
  'sales_create',
  'sales_cancel',
  'product_update',
  'product_trash',
  'product_restore',
  'notifications_list',
  'notifications_unread',
  'notifications_read',
];

const thresholds = {};
for (const name of ROUTES) {
  // Seuil neutre : force l'export des sous-métriques par route.
  thresholds[`http_req_duration{name:${name}}`] = ['max>=0'];
}

export const options = {
  scenarios: {
    main: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      gracefulStop: '15s',
    },
  },
  thresholds,
  summaryTrendStats: [
    'avg',
    'min',
    'med',
    'p(90)',
    'p(95)',
    'p(99)',
    'max',
    'count',
  ],
  discardResponseBodies: false,
  noConnectionReuse: false,
  userAgent: 'stockmaster-load-1-20a/k6',
};

const unexpected = new Counter('unexpected_errors');
const refusals = new Counter('business_refusals');
const limited = new Counter('rate_limited');
const timeouts = new Counter('timeouts');
const late = new Rate('iterations_late');
const iterationTime = new Trend('iteration_duration_ms', true);

const orgs = data.orgs;
const orgByKey = Object.fromEntries(orgs.map((o) => [o.key, o]));
// 1-20B : `TARGET=org:<clé>` concentre la charge sur une seule entreprise.
const inTarget = (s) =>
  TARGET === 'concentrated'
    ? orgByKey[s.org].kind === 'concentrated'
    : TARGET.startsWith('org:')
      ? s.org === TARGET.slice(4)
      : true;
/** Sessions du rôle, entrelacées entre entreprises (tour à tour). */
function byRole(roles) {
  const groups = new Map();
  for (const s of data.sessions) {
    if (!roles.includes(s.role) || !inTarget(s)) continue;
    if (!groups.has(s.org)) groups.set(s.org, []);
    groups.get(s.org).push(s);
  }
  // Mélange déterministe dans chaque entreprise : les premiers VU ne sont
  // pas tous propriétaires (puis administrateurs) ; la part des rôles suit
  // la composition des entreprises dès les petits paliers.
  const lists = [...groups.values()].map((l, k) => shuffled(l, 20 + k));
  const out = [];
  for (let i = 0; out.length < lists.reduce((n, l) => n + l.length, 0); i += 1)
    for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

function shuffled(list, seed) {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pick(list) {
  return list[(exec.vu.idInTest - 1) % list.length];
}
function rand(list) {
  return list[Math.floor(Math.random() * list.length)];
}
function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i += 1) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-${'89ab'[Math.floor(Math.random() * 4)]}${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

let requestSeq = 0;

/**
 * 1-20B : identifiant de corrélation par requête (`x-load-correlation-id`,
 * VU, itération, rang), journalisé avec toute réponse inattendue.
 */
function params(session, name) {
  requestSeq += 1;
  return {
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      'accept-language': 'fr',
      'x-load-correlation-id': `k6-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${requestSeq}`,
    },
    tags: { name },
    timeout: TIMEOUT,
  };
}

/** Classement d'une réponse ; `expected` = statuts métier prévus. */
/**
 * 1-20B — Réponse inattendue journalisée dès la première exécution (ligne
 * `UNEXPECTED {json}` sur la sortie d'erreur, regroupée par le pilote) :
 * route, méthode, statut, code d'erreur métier ou k6, corrélation, extrait
 * court du corps. Jamais le jeton ni le corps de la requête.
 */
let loggedUnexpected = 0;
function logUnexpected(res, name, kind) {
  if (loggedUnexpected >= 50) return;
  loggedUnexpected += 1;
  let code = null;
  try {
    code = res.json('code') ?? null;
  } catch {
    code = null;
  }
  const headers = (res.request && res.request.headers) || {};
  const correlation =
    headers['X-Load-Correlation-Id'] || headers['x-load-correlation-id'];
  console.warn(
    `UNEXPECTED ${JSON.stringify({
      t: new Date().toISOString(),
      route: name,
      method: res.request ? res.request.method : null,
      status: res.status,
      kind,
      code,
      k6Error: res.error || null,
      k6ErrorCode: res.error_code || null,
      durationMs: Math.round(res.timings.duration),
      correlationId: Array.isArray(correlation)
        ? correlation[0]
        : correlation || null,
      body: String(res.body || '').slice(0, 160),
    })}`,
  );
}

function classify(res, name, ok, expected = []) {
  if (res.status === 0) {
    const kind = res.error_code === 1050 ? 'timeout' : 'network';
    unexpected.add(1, { name, kind });
    if (res.error_code === 1050) timeouts.add(1, { name });
    logUnexpected(res, name, kind);
    return false;
  }
  if (res.status === 429) {
    limited.add(1, { name });
    return false;
  }
  if (ok.includes(res.status)) return true;
  if (expected.includes(res.status)) {
    refusals.add(1, { name, status: String(res.status) });
    return false;
  }
  unexpected.add(1, { name, kind: String(res.status) });
  logUnexpected(res, name, String(res.status));
  return false;
}

function get(session, path, name) {
  const res = http.get(`${BASE_URL}${path}`, params(session, name));
  classify(res, name, [200]);
  return res;
}

// ─── Parcours ────────────────────────────────────────────────────────────────

/** Catalogue : liste complète, filtre par rayon, détail. */
function catalog(session) {
  const org = orgByKey[session.org];
  get(session, '/sections', 'sections_list');
  const list = get(session, '/products', 'products_list');
  check(list, {
    'catalogue non vide': (r) => r.status !== 200 || r.json().length > 0,
  });
  get(
    session,
    `/products?sectionId=${rand(org.sectionIds)}`,
    'products_by_section',
  );
  get(session, `/products/${rand(org.productIds)}`, 'product_detail');
}

/** Tableau de bord (analyse) et historique des ventes. */
function dashboard(session) {
  get(session, '/analytics/overview', 'analytics_overview');
  get(session, '/analytics/monthly', 'analytics_monthly');
  get(session, '/analytics/insights', 'analytics_insights');
  get(session, '/sales', 'sales_history');
}

/** Vente (clé d'idempotence comme le web), annulation occasionnelle. */
function sell(session) {
  const org = orgByKey[session.org];
  const body = JSON.stringify({
    productId: rand(org.productIds),
    quantity: 1,
    salePrice: 1000,
    clientOperationId: uuid(),
  });
  const res = http.post(
    `${BASE_URL}/sales`,
    body,
    params(session, 'sales_create'),
  );
  const ok = classify(res, 'sales_create', [201], [400]);
  if (ok && Math.random() < 0.1) {
    const id = res.json('_id');
    const del = http.del(
      `${BASE_URL}/sales/${id}`,
      null,
      params(session, 'sales_cancel'),
    );
    classify(del, 'sales_cancel', [204], [404]);
  }
}

/** Modification de produit et action groupée (corbeille puis restauration). */
function products(session) {
  const org = orgByKey[session.org];
  const id = rand(org.productIds);
  const upd = http.patch(
    `${BASE_URL}/products/${id}`,
    JSON.stringify({
      salePrice: 500 + Math.floor(Math.random() * 50) * 100,
      additionalStock: 1,
    }),
    params(session, 'product_update'),
  );
  classify(upd, 'product_update', [200], [404]);
  if (Math.random() < 0.3) {
    // Comme `use-trash.ts` : N requêtes parallèles (Promise.all).
    const start =
      (exec.vu.idInTest * 7 + exec.vu.iterationInScenario * 3) %
      org.productIds.length;
    const ids = [0, 1, 2].map(
      (k) => org.productIds[(start + k) % org.productIds.length],
    );
    const trashed = http.batch(
      ids.map((p) => [
        'DELETE',
        `${BASE_URL}/products/${p}`,
        null,
        params(session, 'product_trash'),
      ]),
    );
    trashed.forEach((r) => classify(r, 'product_trash', [200], [404]));
    const restored = http.batch(
      ids.map((p) => [
        'PATCH',
        `${BASE_URL}/products/${p}/restore`,
        null,
        params(session, 'product_restore'),
      ]),
    );
    restored.forEach((r) => classify(r, 'product_restore', [200], [404]));
  }
}

/** Centre de notifications : liste, compteur, marquage comme lu. */
function notifications(session) {
  const list = get(session, '/notifications?limit=20', 'notifications_list');
  get(session, '/notifications/unread-count', 'notifications_unread');
  if (list.status === 200) {
    const items = list.json('items') || [];
    const unread = items.find((n) => !n.readAt);
    if (unread) {
      const res = http.post(
        `${BASE_URL}/notifications/${unread.id || unread._id}/read`,
        null,
        params(session, 'notifications_read'),
      );
      classify(res, 'notifications_read', [200, 201, 204], [404]);
    }
  }
}

/** Mixte : rôle de la session, pauses réalistes entre actions. */
function mixed(session) {
  const pause = () => THINK && sleep(1 + Math.random() * 3);
  if (session.role === 'seller') {
    catalog(session);
    pause();
    sell(session);
    pause();
    if (Math.random() < 0.3) {
      // Historique propre (sales.view_own).
      get(session, '/sales', 'sales_history');
    }
  } else if (session.role === 'admin') {
    if (Math.random() < 0.5) products(session);
    else catalog(session);
    pause();
    notifications(session);
  } else {
    dashboard(session);
    pause();
    notifications(session);
  }
}

const PLAN = {
  catalog: { roles: ['owner', 'admin', 'seller'], fn: catalog },
  dashboard: { roles: ['owner', 'admin'], fn: dashboard },
  sales: { roles: ['seller'], fn: sell },
  products: { roles: ['admin'], fn: products },
  notifications: { roles: ['owner', 'admin'], fn: notifications },
  mixed: { roles: ['owner', 'admin', 'seller'], fn: mixed },
};
if (!PLAN[SCENARIO]) throw new Error(`SCENARIO inconnu : ${SCENARIO}`);
const POOL = byRole(PLAN[SCENARIO].roles);
if (POOL.length === 0) throw new Error('Aucune session pour ce scénario.');

export default function () {
  const t0 = Date.now();
  // Une session fixe par VU ; en mixte, la répartition des rôles suit la
  // composition des entreprises (vendeurs majoritaires).
  const session = pick(POOL);
  PLAN[SCENARIO].fn(session);
  const elapsed = (Date.now() - t0) / 1000;
  iterationTime.add(elapsed * 1000);
  late.add(elapsed > PACE_S);
  if (elapsed < PACE_S) sleep(PACE_S - elapsed);
}

export function handleSummary(summary) {
  const out = __ENV.SUMMARY_OUT;
  const result = {};
  if (out) result[out] = JSON.stringify(summary, null, 2);
  result.stdout = `k6 ${SCENARIO} target=${TARGET} vus=${VUS} duration=${DURATION} pace=${PACE_S}s reqs=${summary.metrics.http_reqs ? summary.metrics.http_reqs.values.count : 0}\n`;
  return result;
}
