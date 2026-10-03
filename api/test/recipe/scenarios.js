/**
 * 1-14D.2H — Campagne navigateur de la recette (TEST).
 *
 * - Scénarios 1 à 12 (15 cas) : repris de l'outillage temporaire 1-14D.2C
 *   (`pw14d2c/scenarios.js`, retrouvé intact), adaptés à la stack de la
 *   recette ; assertions inchangées. Fournisseur `simulated`.
 * - W1, R1, R2 : parcours intégrés ajoutés (webhook, rapprochement), sur le
 *   VRAI adaptateur CamPay et le faux CamPay local (fournisseur `campay`).
 *
 * Lancement : node api/test/recipe/recipe.js scenarios [ids...] --playwright=<dir>
 * Résultats : `results.json` et captures d'échec dans `RECIPE_RESULTS_DIR`.
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const { WEB, API, PHONE } = L;
const MARKER_KEY = 'stockmaster_payment_intents';
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const results = [];

const loaded = L.loadPlaywright();
if (loaded.error) {
  console.log(
    `Playwright indisponible (${loaded.error}) : AUCUNE campagne exécutée.`,
  );
  process.exit(3);
}
const { chromium } = loaded.playwright;
console.log(
  `Playwright ${loaded.version} (${loaded.modulePath}) ; Chromium ${loaded.executable}`,
);

const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function scenario(id, title, provider, fn) {
  if (only.length && !only.includes(id)) return;
  const browser = await chromium.launch({ executablePath: loaded.executable });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const requests = [];
  const consoleLines = [];
  const track = (p) => {
    p.on('request', (r) =>
      requests.push({
        method: r.method(),
        url: r.url(),
        body: r.postData() || null,
        page: p,
      }),
    );
    p.on('console', (m) => consoleLines.push(m.text()));
  };
  track(page);
  const t0 = Date.now();
  try {
    await L.restartApi(provider);
    const notes = await fn({
      browser,
      context,
      page,
      requests,
      consoleLines,
      track,
    });
    results.push({
      id,
      title,
      provider,
      status: 'PASS',
      ms: Date.now() - t0,
      notes: notes || '',
    });
    console.log(`PASS ${id} ${title}${notes ? ' — ' + notes : ''}`);
  } catch (e) {
    results.push({
      id,
      title,
      provider,
      status: 'FAIL',
      ms: Date.now() - t0,
      error: String(e && e.stack),
    });
    console.log(`FAIL ${id} ${title} — ${e && e.message}`);
    try {
      await page.screenshot({
        path: path.join(L.outputDir(), `fail-${id}.png`),
        fullPage: true,
      });
    } catch {
      // capture facultative
    }
  } finally {
    await browser.close();
  }
}

// ─── Aides (reprises de D.2C) ────────────────────────────────────────────────
const isPayment = (r) =>
  r.url.startsWith(API) &&
  r.url.includes('/organizations/current/subscription/payments');
const payReqs = (requests, since = 0) =>
  requests.slice(since).filter(isPayment);
const creations = (requests, since = 0) =>
  payReqs(requests, since).filter(
    (r) => r.method === 'POST' && /\/payments$/.test(new URL(r.url).pathname),
  );
const refreshes = (requests, since = 0) =>
  payReqs(requests, since).filter(
    (r) => r.method === 'POST' && /\/refresh$/.test(new URL(r.url).pathname),
  );
const waitText = (page, text, timeout = 15000) =>
  page.getByText(text, { exact: false }).first().waitFor({ timeout });
const statusOf = (page) =>
  page.locator('[data-testid=current-payment]').getAttribute('data-status');
const waitStatus = (page, status, timeout = 15000) =>
  page
    .locator(`[data-testid=current-payment][data-status=${status}]`)
    .waitFor({ timeout });
const marker = (page) =>
  page.evaluate((k) => localStorage.getItem(k), MARKER_KEY);
const markerEntries = async (page) => JSON.parse((await marker(page)) || '[]');
const panel = (page) =>
  page.locator('[data-testid=subscription-payment-panel]');
const settleWait = (ms) => new Promise((r) => setTimeout(r, ms));
const displayedReference = (page) =>
  page.locator('[data-testid=current-payment] dd.font-mono').innerText();

async function loginApp(page, email) {
  await L.uiLogin(page, email);
  await page.waitForURL(`${WEB}/app`, { timeout: 20000 });
}
async function loginAccess(page, email) {
  await L.uiLogin(page, email);
  await page.waitForURL(`${WEB}/access`, { timeout: 20000 });
  await panel(page).waitFor({ timeout: 20000 });
}
async function openSubscription(page) {
  await page.goto(`${WEB}/app/organization/subscription`);
  await panel(page).waitFor({ timeout: 20000 });
}
async function fillPayment(page, { term = '1 mois', phone = PHONE } = {}) {
  const renew = page.getByRole('button', { name: 'Renouveler', exact: true });
  if (await renew.count()) await renew.click();
  await page.getByRole('radio', { name: new RegExp(`^${term}`) }).click();
  await page.fill('#payer-phone', phone);
}
const submit = (page) => page.locator('[data-testid=payment-submit]').click();
async function payUi(page, opts) {
  await fillPayment(page, opts);
  await submit(page);
}
async function dbPayments(orgId) {
  return (await L.db())
    .collection('subscription_payments')
    .find({ organizationId: L.oid(orgId) })
    .toArray();
}
async function apiPay(token, extra = {}) {
  return L.http('POST', '/organizations/current/subscription/payments', {
    token,
    body: {
      term: 'monthly',
      payerPhone: PHONE,
      clientOperationId: crypto.randomUUID(),
      ...extra,
    },
  });
}
async function logoutLocal(page) {
  await page.evaluate(() => {
    localStorage.removeItem('heyama_token');
    localStorage.removeItem('heyama_user');
    sessionStorage.clear();
  });
}
async function recordSaleUi(page, productId) {
  await page.goto(`${WEB}/app/catalog/products/${productId}`);
  await page.getByRole('button', { name: 'Enregistrer une vente' }).click();
  await page.fill('#s-qty', '1');
  await page.fill('#s-price', '400');
  await page.getByRole('button', { name: /Confirmer la vente/ }).click();
}
async function paymentPeriods(paymentId) {
  return (await L.db()).collection('subscription_periods').countDocuments({
    source: 'payment',
    sourceReference: `payment:${paymentId}`,
  });
}
async function audits(paymentId) {
  return (await L.db())
    .collection('subscription_payment_reconciliations')
    .countDocuments({ paymentId: L.oid(paymentId) });
}
const collects = async () => (await L.sim.stats()).initiations.length;

(async () => {
  // ════════════════ Scénarios 1-14D.2C (fournisseur simulé) ════════════════

  await scenario(
    '1',
    'Propriétaire actif et limité ; admin et vendeur sans parcours',
    'simulated',
    async ({ browser, page }) => {
      const active = await L.registerOwner('own-active');
      await loginApp(page, active.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');

      const expired = await L.registerOwner('own-limited');
      const seller = await L.inviteMember(
        expired.token,
        'seller',
        'sel-limited',
      );
      const admin = await L.inviteMember(active.token, 'admin', 'adm-active');
      const seller2 = await L.inviteMember(
        active.token,
        'seller',
        'sel-active',
      );
      await L.expireOrg(expired.orgId);
      const ctx2 = await browser.newContext();
      const p2 = await ctx2.newPage();
      await loginAccess(p2, expired.email);
      await payUi(p2);
      await waitStatus(p2, 'pending');
      await ctx2.close();
      ok((await collects()) === 2, 'deux collectes (une par propriétaire)');

      for (const member of [admin, seller2]) {
        const c = await browser.newContext();
        const p = await c.newPage();
        const reqs = [];
        p.on('request', (r) => reqs.push({ method: r.method(), url: r.url() }));
        await loginApp(p, member.email);
        await p.goto(`${WEB}/app/organization/subscription`);
        await waitText(p, 'réservée au propriétaire');
        ok(
          (await panel(p).count()) === 0,
          'aucun panneau pour un non-propriétaire',
        );
        ok(reqs.filter(isPayment).length === 0, 'aucun appel de paiement');
        await c.close();
      }
      const c3 = await browser.newContext();
      const p3 = await c3.newPage();
      const reqs3 = [];
      p3.on('request', (r) => reqs3.push({ method: r.method(), url: r.url() }));
      await L.uiLogin(p3, seller.email);
      await p3.waitForURL(`${WEB}/access`);
      await waitText(p3, 'Contactez le propriétaire');
      ok((await panel(p3).count()) === 0, 'vendeur limité : aucun panneau');
      ok(
        reqs3.filter(isPayment).length === 0,
        'vendeur limité : aucun appel de paiement',
      );
      await c3.close();
      return 'propriétaire app + limité : pending ; admin, vendeur, vendeur limité : aucun panneau ni appel';
    },
  );

  await scenario(
    '2',
    'Double clic : une seule soumission, UUID conservé',
    'simulated',
    async ({ page, requests }) => {
      const o = await L.registerOwner('dbl');
      await loginApp(page, o.email);
      await openSubscription(page);
      await fillPayment(page);
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid=payment-submit]');
        b.click();
        b.click();
        b.click();
      });
      await waitStatus(page, 'pending');
      await settleWait(500);
      const posts = creations(requests);
      ok(posts.length === 1, `POST de création : ${posts.length}`);
      const uuid = JSON.parse(posts[0].body).clientOperationId;
      const m = await markerEntries(page);
      ok(
        m.length === 1 && m[0].clientOperationId === uuid && m[0].paymentId,
        'marqueur : même UUID + paymentId',
      );
      ok(
        (await dbPayments(o.orgId)).length === 1 && (await collects()) === 1,
        '1 paiement, 1 collecte',
      );
      return `1 POST, UUID ${uuid.slice(0, 8)} conservé dans le marqueur`;
    },
  );

  await scenario(
    '3a',
    'Réponse perdue (paiement créé) puis rechargement : paiement relu, aucun second POST',
    'simulated',
    async ({ page, requests }) => {
      const o = await L.registerOwner('lost-a');
      await loginApp(page, o.email);
      await openSubscription(page);
      await page.route(
        `${API}/organizations/current/subscription/payments`,
        async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fetch();
          return route.abort('failed');
        },
      );
      await payUi(page);
      await waitText(page, 'Réponse non reçue');
      let m = await markerEntries(page);
      ok(
        m.length === 1 && m[0].paymentId === null && m[0].clientOperationId,
        'intention conservée sans paymentId',
      );
      const uuid = m[0].clientOperationId;
      ok(
        (await dbPayments(o.orgId)).length === 1,
        'paiement créé côté serveur',
      );
      await page.unroute(`${API}/organizations/current/subscription/payments`);
      await page.reload();
      await waitStatus(page, 'pending');
      ok(creations(requests).length === 1, 'aucun second POST');
      m = await markerEntries(page);
      ok(
        m[0].paymentId === String((await dbPayments(o.orgId))[0]._id),
        'paiement retrouvé (historique serveur)',
      );
      ok((await collects()) === 1, 'une seule collecte');
      return `UUID ${uuid.slice(0, 8)} : paiement relu après rechargement`;
    },
  );

  await scenario(
    '3b',
    'Réponse perdue + historique indisponible : même UUID et même durée rejoués après nouvelle saisie',
    'simulated',
    async ({ page, requests }) => {
      const o = await L.registerOwner('lost-b');
      await loginApp(page, o.email);
      await openSubscription(page);
      await page.route(
        `${API}/organizations/current/subscription/payments`,
        async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          await route.fetch();
          return route.abort('failed');
        },
      );
      await payUi(page, { term: '3 mois' });
      await waitText(page, 'Réponse non reçue');
      const uuid = (await markerEntries(page))[0].clientOperationId;
      await page.unroute(`${API}/organizations/current/subscription/payments`);
      await page.route(
        `${API}/organizations/current/subscription/payments?**`,
        (route) => route.abort('failed'),
      );
      await page.reload();
      await page.locator('[data-testid=payment-locked-intent]').waitFor();
      ok(
        (
          await page.locator('[data-testid=payment-locked-intent]').innerText()
        ).includes('3 mois'),
        'durée verrouillée',
      );
      ok((await page.getByRole('radio').count()) === 0, 'durée non modifiable');
      ok(
        (await page.inputValue('#payer-phone')) === '',
        'téléphone NON conservé : nouvelle saisie',
      );
      await page.fill('#payer-phone', PHONE);
      await submit(page);
      await waitStatus(page, 'pending');
      const posts = creations(requests);
      ok(posts.length === 2, `deux POST (envoi + rejeu) : ${posts.length}`);
      const bodies = posts.map((p) => JSON.parse(p.body));
      ok(
        bodies.every(
          (b) => b.clientOperationId === uuid && b.term === 'quarterly',
        ),
        'même UUID, même durée',
      );
      await waitText(page, 'Demande retrouvée');
      ok(
        (await dbPayments(o.orgId)).length === 1 && (await collects()) === 1,
        '1 paiement, 1 collecte',
      );
      return 'rejeu `replayed` : 1 paiement, 1 collecte, aucun nouvel UUID';
    },
  );

  await scenario(
    '3c',
    'Requête jamais arrivée : même UUID au nouvel envoi ; marqueur sans téléphone ni jeton',
    'simulated',
    async ({ page, requests, consoleLines }) => {
      const o = await L.registerOwner('lost-c');
      await loginApp(page, o.email);
      await openSubscription(page);
      await page.route(
        `${API}/organizations/current/subscription/payments`,
        (route) =>
          route.request().method() === 'POST'
            ? route.abort('internetdisconnected')
            : route.continue(),
      );
      await payUi(page);
      await waitText(page, 'Réponse non reçue');
      const raw = await marker(page);
      const token = await page.evaluate(() =>
        localStorage.getItem('heyama_token'),
      );
      const entries = JSON.parse(raw);
      ok(entries.length === 1, 'une entrée');
      const keys = Object.keys(entries[0]).sort().join(',');
      ok(
        keys ===
          'clientOperationId,organizationId,paymentId,savedAt,term,userId',
        `clés du marqueur : ${keys}`,
      );
      for (const leak of [
        PHONE,
        '77123456',
        '237677',
        token,
        token.split('.')[2],
      ]) {
        ok(
          !raw.includes(leak),
          `fuite dans le marqueur : ${leak.slice(0, 10)}`,
        );
      }
      ok(
        entries[0].userId === o.userId && entries[0].organizationId === o.orgId,
        'portée utilisateur + organisation',
      );
      ok(
        !consoleLines.some((l) => l.includes(PHONE) || l.includes(token)),
        'aucun téléphone ni jeton dans la console',
      );
      const uuid = entries[0].clientOperationId;
      await page.unroute(`${API}/organizations/current/subscription/payments`);
      await page.reload();
      await page.locator('[data-testid=payment-locked-intent]').waitFor();
      await page.fill('#payer-phone', PHONE);
      await submit(page);
      await waitStatus(page, 'pending');
      const sent = creations(requests)
        .filter((r) => r.body)
        .map((r) => JSON.parse(r.body).clientOperationId);
      ok(sent.length === 2 && sent.every((u) => u === uuid), 'même UUID');
      ok((await dbPayments(o.orgId)).length === 1, 'un paiement');
      return `marqueur : ${keys} ; aucun téléphone/jeton ; UUID rejoué`;
    },
  );

  await scenario(
    '4',
    'Paiement ouvert et conflit entre onglets : paiement existant affiché, une collecte',
    'simulated',
    async ({ context, page, requests, track }) => {
      const o = await L.registerOwner('tabs');
      await loginApp(page, o.email);
      const tabB = await context.newPage();
      track(tabB);
      await openSubscription(page);
      await openSubscription(tabB);
      await fillPayment(page);
      await fillPayment(tabB, { term: '12 mois' });
      await submit(page);
      await waitStatus(page, 'pending');
      await submit(tabB);
      await waitStatus(tabB, 'pending');
      await waitText(tabB, 'Un paiement est déjà en cours');
      const refA = await displayedReference(page);
      const refB = await displayedReference(tabB);
      ok(refA === refB, 'même paiement affiché dans les deux onglets');
      ok(
        (await tabB.locator('[data-testid=payment-term]').innerText()) ===
          '1 mois',
        'durée du paiement existant (serveur)',
      );
      ok(
        (await dbPayments(o.orgId)).length === 1 && (await collects()) === 1,
        '1 paiement, 1 collecte',
      );
      ok(creations(requests).length === 2, 'B : une tentative, refusée 409');
      ok(
        (await tabB.locator('[data-testid=payment-submit]').count()) === 0,
        'B : aucun formulaire de nouvelle collecte',
      );
      return '409 PAYMENT_ALREADY_PENDING → paiement A affiché dans B';
    },
  );

  await scenario(
    '5',
    'Nouvel essai après `failed` : action explicite + relecture serveur, nouvel UUID',
    'simulated',
    async ({ page, requests }) => {
      const o = await L.registerOwner('retry');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      await L.sim.settle(await displayedReference(page), 'failed');
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitStatus(page, 'failed');
      ok(
        (await page.locator('[data-testid=payment-submit]').count()) === 0,
        'aucun formulaire automatique après échec',
      );
      ok(
        (await page
          .getByRole('button', { name: 'Renouveler', exact: true })
          .count()) === 0,
        'pas de Renouveler implicite',
      );
      const id1 = String((await dbPayments(o.orgId))[0]._id);
      const uuid1 = JSON.parse(creations(requests)[0].body).clientOperationId;

      const d = await L.db();
      await d
        .collection('subscription_payments')
        .updateOne(
          { _id: L.oid(id1) },
          { $set: { status: 'review', open: false } },
        );
      const before = requests.length;
      await page.getByRole('button', { name: 'Nouvel essai' }).click();
      await waitStatus(page, 'review');
      const reads = payReqs(requests, before).filter(
        (r) => r.method === 'GET' && r.url.endsWith(`/payments/${id1}`),
      );
      ok(
        reads.length === 1,
        `relecture serveur avant décision (${reads.length})`,
      );
      ok(
        (await page.locator('[data-testid=payment-submit]').count()) === 0,
        'review relu : pas de formulaire',
      );

      await d
        .collection('subscription_payments')
        .updateOne(
          { _id: L.oid(id1) },
          { $set: { status: 'failed', open: false } },
        );
      await page.reload();
      await waitStatus(page, 'failed');
      ok(
        (await page.locator('[data-testid=payment-submit]').count()) === 0,
        'aucun formulaire sans action',
      );
      const before2 = requests.length;
      await page.getByRole('button', { name: 'Nouvel essai' }).click();
      await page.locator('[data-testid=payment-submit]').waitFor();
      ok(
        payReqs(requests, before2).filter(
          (r) => r.method === 'GET' && r.url.endsWith(`/payments/${id1}`),
        ).length === 1,
        'relecture serveur avant le formulaire',
      );
      await payUi(page, { term: '3 mois' });
      await waitStatus(page, 'pending');
      const posts = creations(requests);
      const uuid2 = JSON.parse(posts[posts.length - 1].body).clientOperationId;
      ok(uuid2 !== uuid1, 'nouvelle intention : nouvel UUID');
      ok(
        (await dbPayments(o.orgId)).length === 2 && (await collects()) === 2,
        '2 paiements, 2 collectes',
      );
      return 'review relu → aucun formulaire ; failed → nouvel essai explicite, nouvel UUID';
    },
  );

  await scenario(
    '5b',
    'Nouvel essai immédiat : relecture `failed` puis formulaire',
    'simulated',
    async ({ page, requests }) => {
      const o = await L.registerOwner('retry-b');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      await L.sim.settle(await displayedReference(page), 'failed');
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitStatus(page, 'failed');
      const id1 = String((await dbPayments(o.orgId))[0]._id);
      const before = requests.length;
      await page.getByRole('button', { name: 'Nouvel essai' }).click();
      await page.locator('[data-testid=payment-submit]').waitFor();
      const reads = payReqs(requests, before).filter(
        (r) => r.method === 'GET' && r.url.endsWith(`/payments/${id1}`),
      );
      ok(reads.length === 1, 'relecture serveur récente');
      ok(
        (await markerEntries(page)).length === 0,
        'ancienne intention abandonnée',
      );
      await fillPayment(page);
      await submit(page);
      await waitStatus(page, 'pending');
      ok((await collects()) === 2, '2 collectes au total');
      return 'clic → GET → failed confirmé → formulaire → nouvelle collecte';
    },
  );

  await scenario(
    '6',
    'Attente prolongée, uncertain, review, 503 : aucun nouvel essai automatique',
    'simulated',
    async ({ browser, page, requests }) => {
      await page.clock.install();
      const o = await L.registerOwner('wait');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      const before = payReqs(requests).length;
      await page.clock.fastForward('30:00');
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
      });
      await settleWait(1500);
      ok(
        payReqs(requests).length === before,
        'aucun appel de paiement après 30 min simulées + focus',
      );
      ok(
        (await statusOf(page)) === 'pending',
        'toujours en attente (jamais échec local)',
      );
      ok(
        (await page.locator('[data-testid=payment-submit]').count()) === 0,
        'pas de nouvelle collecte',
      );

      await page.route(
        `${API}/organizations/current/subscription/payments/*/refresh`,
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': WEB },
            body: JSON.stringify({
              statusCode: 503,
              code: 'PAYMENT_CONFIRMATION_PENDING',
              message: 'x',
            }),
          }),
      );
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitText(page, 'Paiement en cours de confirmation');
      const r1 = refreshes(requests).length;
      await page.clock.fastForward('10:00');
      await settleWait(1000);
      ok(
        refreshes(requests).length === r1 && r1 === 1,
        `aucune relance après 503 (${r1})`,
      );
      ok((await statusOf(page)) === 'pending', 'état inchangé après 503');

      const u = await L.registerOwner('uncertain');
      await L.sim.queueInit('lost');
      const cu = await browser.newContext();
      const pu = await cu.newPage();
      const ru = [];
      pu.on('request', (r) => ru.push({ method: r.method(), url: r.url() }));
      await loginApp(pu, u.email);
      await openSubscription(pu);
      await payUi(pu);
      await waitStatus(pu, 'uncertain');
      await waitText(pu, 'Résultat à vérifier');
      ok(
        (await pu.locator('[data-testid=payment-submit]').count()) === 0,
        'uncertain : pas de formulaire',
      );
      ok(
        (await pu
          .getByRole('button', { name: 'Renouveler', exact: true })
          .count()) === 0,
        'uncertain : pas de Renouveler',
      );
      const ruBefore = ru.filter(isPayment).length;
      await settleWait(1500);
      ok(
        ru.filter(isPayment).length === ruBefore,
        'uncertain : aucun appel automatique',
      );
      await cu.close();

      const rv = await L.registerOwner('review');
      const cr = await browser.newContext();
      const pr = await cr.newPage();
      await loginApp(pr, rv.email);
      await openSubscription(pr);
      await payUi(pr);
      await waitStatus(pr, 'pending');
      await L.sim.settle(await displayedReference(pr), 'succeeded');
      await L.sim.queueStatus({ override: { amount: 2999 } });
      await pr.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitStatus(pr, 'review');
      await waitText(pr, 'Vérification nécessaire');
      ok(
        (await pr.locator('[data-testid=payment-submit]').count()) === 0,
        'review : pas de formulaire',
      );
      ok(
        (await pr.getByRole('button', { name: 'Nouvel essai' }).count()) === 0,
        'review : pas de nouvel essai',
      );
      await cr.close();

      const un = await L.registerOwner('unavail');
      await L.sim.queueInit('unavailable');
      const cn = await browser.newContext();
      const pn = await cn.newPage();
      await loginApp(pn, un.email);
      await openSubscription(pn);
      await payUi(pn);
      await waitText(pn, 'Le paiement en ligne est indisponible');
      ok(
        (await pn.locator('[data-testid=current-payment]').count()) === 0,
        'aucun paiement présenté comme créé',
      );
      ok(
        (await pn.locator('[data-status=succeeded]').count()) === 0,
        'aucun faux succès (aucun élément `succeeded`)',
      );
      ok(
        (await pn.getByText('Paiement confirmé', { exact: true }).count()) ===
          0,
        'aucun libellé de succès',
      );
      await cn.close();
      return 'pending après 30 min, uncertain, review, 503 confirmation/indisponible : aucune action automatique';
    },
  );

  await scenario(
    '7',
    'Montant et durée figés renvoyés par l’API',
    'simulated',
    async ({ page }) => {
      const o = await L.registerOwner('frozen');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page, { term: '6 mois' });
      await waitStatus(page, 'pending');
      ok(
        (await page.locator('[data-testid=payment-amount]').innerText())
          .replace(/\s/g, ' ')
          .includes('16 000'),
        'montant initial',
      );
      const d = await L.db();
      await d
        .collection('subscription_payments')
        .updateOne(
          { organizationId: L.oid(o.orgId) },
          { $set: { amount: 15999 } },
        );
      await page.reload();
      await waitStatus(page, 'pending');
      const amount = (
        await page.locator('[data-testid=payment-amount]').innerText()
      ).replace(/\s/g, ' ');
      ok(amount.includes('15 999'), `montant de l'API affiché : ${amount}`);
      ok(
        (await page.locator('[data-testid=payment-term]').innerText()) ===
          '6 mois',
        'durée de l’API',
      );
      const hist = (
        await page.locator('[data-testid=payment-history]').innerText()
      ).replace(/\s/g, ' ');
      ok(hist.includes('15 999'), 'historique : montant de l’API');
      return `affiché : ${amount} (catalogue : 16 000)`;
    },
  );

  await scenario(
    '8',
    'Vérification manuelle uniquement : aucun polling ni refresh au focus',
    'simulated',
    async ({ page, requests }) => {
      await page.clock.install();
      const o = await L.registerOwner('manual');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      const stats0 = await L.sim.stats();
      await page.clock.fastForward('02:00:00');
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await settleWait(1500);
      ok(refreshes(requests).length === 0, 'aucun refresh automatique');
      ok(
        (await L.sim.stats()).statusCalls === stats0.statusCalls,
        'aucune consultation prestataire',
      );
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitText(page, 'Statut vérifié');
      ok(
        refreshes(requests).length === 1 &&
          (await L.sim.stats()).statusCalls === stats0.statusCalls + 1,
        'un refresh sur action',
      );
      return '2 h simulées + focus : 0 refresh ; clic : 1 refresh';
    },
  );

  await scenario(
    '9',
    'Succès puis échange `complete` existant ; suspension prioritaire',
    'simulated',
    async ({ browser, page, requests }) => {
      const o = await L.registerOwner('success');
      await L.expireOrg(o.orgId);
      await loginAccess(page, o.email);
      await payUi(page);
      await waitStatus(page, 'pending');
      await L.sim.settle(await displayedReference(page), 'succeeded');
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await page.waitForURL(`${WEB}/app`, { timeout: 20000 });
      const completes = requests.filter(
        (r) =>
          r.method === 'POST' &&
          r.url === `${API}/auth/subscription-access/complete`,
      );
      ok(completes.length === 1, `échange complete : ${completes.length}`);
      ok(
        await page.evaluate(() => !!localStorage.getItem('heyama_token')),
        'JWT applicatif installé',
      );
      ok(
        await page.evaluate(
          () =>
            sessionStorage.getItem('stockmaster_restricted_session') === null,
        ),
        'jeton limité effacé',
      );
      ok(
        (await markerEntries(page)).length === 0,
        'marqueur effacé après succès',
      );

      const s = await L.registerOwner('suspended');
      await L.expireOrg(s.orgId);
      const cs = await browser.newContext();
      const ps = await cs.newPage();
      const rs = [];
      ps.on('request', (r) => rs.push({ method: r.method(), url: r.url() }));
      await loginAccess(ps, s.email);
      await payUi(ps);
      await waitStatus(ps, 'pending');
      const refS = await displayedReference(ps);
      const d = await L.db();
      await d
        .collection('organizations')
        .updateOne({ _id: L.oid(s.orgId) }, { $set: { status: 'suspended' } });
      await L.sim.settle(refS, 'succeeded');
      await ps.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitText(ps, 'Accès refusé');
      await settleWait(800);
      ok(ps.url() === `${WEB}/access`, 'reste sur /access');
      ok(
        !rs.some((r) => r.url.endsWith('/auth/subscription-access/complete')),
        'aucun échange tenté',
      );
      ok(
        (await d.collection('organizations').findOne({ _id: L.oid(s.orgId) }))
          .status === 'suspended',
        'suspension inchangée',
      );
      await cs.close();
      return 'succès → complete → /app ; suspendu : 403, aucun échange';
    },
  );

  await scenario(
    '10',
    'Changement d’organisation, d’utilisateur et réauthentification sans fuite',
    'simulated',
    async ({ page }) => {
      const a = await L.registerOwner('reauthA');
      const b = await L.registerOwner('reauthB');
      const d = await L.db();
      await d.collection('organizationmemberships').insertOne({
        organizationId: L.oid(b.orgId),
        userId: L.oid(a.userId),
        role: 'admin',
        status: 'active',
        permissions: [],
        invitedBy: null,
        joinedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await L.uiLogin(page, a.email);
      await page.getByRole('button', { name: /Shop reauthA/ }).click();
      await page.waitForURL(`${WEB}/app`);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      const refA = await displayedReference(page);
      await logoutLocal(page);
      await L.uiLogin(page, a.email);
      await page.getByRole('button', { name: /Shop reauthB/ }).click();
      await page.waitForURL(`${WEB}/app`);
      await page.goto(`${WEB}/app/organization/subscription`);
      await waitText(page, 'réservée au propriétaire');
      ok(
        !(await page.content()).includes(refA),
        'org B : référence de A absente',
      );
      await logoutLocal(page);
      await loginApp(page, b.email);
      await openSubscription(page);
      await waitText(page, 'Aucun paiement.');
      ok(
        (await page.locator('[data-testid=current-payment]').count()) === 0,
        'B : aucun paiement courant',
      );
      ok(!(await page.content()).includes(refA), 'B : référence de A absente');
      await logoutLocal(page);
      await L.uiLogin(page, a.email);
      await page.getByRole('button', { name: /Shop reauthA/ }).click();
      await page.waitForURL(`${WEB}/app`);
      await openSubscription(page);
      await waitStatus(page, 'pending');
      ok((await displayedReference(page)) === refA, 'paiement de A retrouvé');
      return 'org B / utilisateur B : aucune donnée de A ; réauthentification : paiement retrouvé';
    },
  );

  await scenario(
    '11',
    'Paiements hors outbox ; vente en attente conservée puis synchronisée',
    'simulated',
    async ({ page }) => {
      const o = await L.registerOwner('outbox');
      const { productId } = await L.seedProduct(o.token, o.orgId, 10);
      await loginApp(page, o.email);
      await page.route(`${API}/sales`, (route) =>
        route.request().method() === 'POST'
          ? route.abort('internetdisconnected')
          : route.continue(),
      );
      await recordSaleUi(page, productId);
      let box;
      for (let i = 0; i < 40; i++) {
        box = await L.outboxOps(page);
        if (box && box.ops && box.ops.length === 1) break;
        await settleWait(250);
      }
      ok(
        box.ops.length === 1 && box.ops[0].status === 'pending',
        'vente en attente dans l’outbox',
      );
      const saleUuid = box.ops[0].clientOperationId;
      await L.expireOrg(o.orgId);
      await page.unroute(`${API}/sales`);
      await page.goto(`${WEB}/app`);
      await waitText(page, "L'abonnement de ce commerce a expiré");
      await panel(page).waitFor();
      await payUi(page);
      await waitStatus(page, 'pending');
      box = await L.outboxOps(page);
      ok(
        box.ops.length === 1 && box.ops[0].clientOperationId === saleUuid,
        'outbox : uniquement la vente (paiement hors outbox)',
      );
      ok(
        box.ops.every((op) => !JSON.stringify(op).includes('subscription')),
        'aucune opération de paiement',
      );
      await L.sim.settle(await displayedReference(page), 'succeeded');
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await page
        .getByRole('link', { name: 'Catalogue' })
        .first()
        .waitFor({ timeout: 20000 });
      for (let i = 0; i < 60; i++) {
        box = await L.outboxOps(page);
        if (box.ops[0] && box.ops[0].status === 'synced') break;
        await settleWait(500);
      }
      ok(
        box.ops.length === 1 &&
          box.ops[0].clientOperationId === saleUuid &&
          box.ops[0].status === 'synced',
        `vente rejouée (${box.ops[0].status})`,
      );
      const d = await L.db();
      ok(
        (await d
          .collection('sales')
          .countDocuments({ productId: L.oid(productId) })) === 1,
        'une vente',
      );
      return `vente ${saleUuid.slice(0, 8)} conservée pendant le paiement puis synchronisée`;
    },
  );

  await scenario(
    '12',
    'Historique paginé, 429 Retry-After, 401 limité, clavier et mobile',
    'simulated',
    async ({ browser, page }) => {
      const o = await L.registerOwner('history');
      for (let i = 0; i < 7; i++) {
        await L.sim.queueInit('reject');
        const res = await apiPay(o.token);
        ok(
          res.status === 201 && res.body.status === 'failed',
          `paiement refusé ${i}`,
        );
      }
      await loginApp(page, o.email);
      await openSubscription(page);
      const items = page.locator('[data-testid=payment-history-item]');
      await items.first().waitFor();
      ok((await items.count()) === 5, `page 1 : ${await items.count()}`);
      let limitedOnce = true;
      await page.route(
        `${API}/organizations/current/subscription/payments?*before*`,
        (route) => {
          if (!limitedOnce) return route.continue();
          limitedOnce = false;
          return route.fulfill({
            status: 429,
            contentType: 'application/json',
            headers: {
              'Retry-After': '2',
              'Access-Control-Allow-Origin': WEB,
              'Access-Control-Expose-Headers': 'Retry-After',
            },
            body: JSON.stringify({
              statusCode: 429,
              code: 'PAYMENT_RATE_LIMITED',
              message: 'x',
            }),
          });
        },
      );
      await page.getByRole('button', { name: 'Afficher plus' }).click();
      await waitText(page, 'Trop de demandes');
      ok(
        await page.getByRole('button', { name: 'Afficher plus' }).isEnabled(),
        'lecture : bouton toujours présent',
      );
      await page.getByRole('button', { name: 'Afficher plus' }).click();
      for (let i = 0; i < 40 && (await items.count()) < 7; i++)
        await settleWait(200);
      ok(
        (await items.count()) === 7,
        `après pagination : ${await items.count()}`,
      );
      ok(
        (await page.getByRole('button', { name: 'Afficher plus' }).count()) ===
          0,
        'fin de pagination',
      );

      const k = await L.registerOwner('keyboard');
      const ck = await browser.newContext({
        viewport: { width: 360, height: 740 },
        isMobile: true,
        hasTouch: true,
      });
      const pk = await ck.newPage();
      await loginApp(pk, k.email);
      await openSubscription(pk);
      const renew = pk.getByRole('button', { name: 'Renouveler', exact: true });
      await renew.focus();
      await pk.keyboard.press('Enter');
      const radio = pk.getByRole('radio', { name: /^1 mois/ });
      await radio.focus();
      await pk.keyboard.press('Space');
      await pk.locator('#payer-phone').focus();
      await pk.keyboard.type(PHONE);
      await pk.keyboard.press('Enter');
      await waitStatus(pk, 'pending');
      const overflow = await pk.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      ok(overflow <= 0, `débordement horizontal : ${overflow}px`);
      const live = await pk
        .locator(
          '[data-testid=current-payment] [role=status][aria-live=polite]',
        )
        .count();
      ok(live === 1, 'statut annoncé (aria-live)');
      await pk.screenshot({
        path: path.join(L.outputDir(), 'mobile-360-pending.png'),
        fullPage: true,
      });
      await ck.close();

      const x = await L.registerOwner('expired401');
      await L.expireOrg(x.orgId);
      const cx = await browser.newContext();
      const px = await cx.newPage();
      await loginAccess(px, x.email);
      await payUi(px);
      await waitStatus(px, 'pending');
      await px.route(
        `${API}/organizations/current/subscription/payments/*/refresh`,
        (route) =>
          route.fulfill({
            status: 401,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': WEB },
            body: JSON.stringify({ statusCode: 401, message: 'Unauthorized' }),
          }),
      );
      await px.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitText(px, 'Votre session a expiré');
      ok((await statusOf(px)) === 'pending', '401 : état inchangé');
      await cx.close();
      return '5 + 2 éléments, 429 puis reprise manuelle ; clavier + 360 px sans débordement ; 401 limité';
    },
  );

  // ════════════════ Parcours intégrés 1-14D.2H (fournisseur campay) ════════

  await scenario(
    'W1',
    'Webhook POST signé (clé fictive) puis rejeu : une période, aucune seconde collecte',
    'campay',
    async ({ page, requests }) => {
      // Défaut : en mode simulé, le webhook reste désactivé (aucune injection).
      await L.restartApi('simulated');
      const disabled = await L.A.postNotification('{}');
      ok(
        disabled.status === 503 &&
          disabled.body.code === 'PAYMENT_WEBHOOK_DISABLED',
        `webhook désactivé par défaut (${disabled.status})`,
      );
      await L.restartApi('campay');

      const o = await L.registerOwner('webhook');
      await L.expireOrg(o.orgId);
      await loginAccess(page, o.email);
      await payUi(page);
      await waitStatus(page, 'pending');
      const [payment] = await dbPayments(o.orgId);
      ok(
        payment.provider === 'campay' &&
          /^[0-9a-f-]{36}$/.test(payment.providerReference),
        'collecte CamPay (faux) avec référence UUID',
      );
      ok((await L.sim.stats()).collectCalls === 1, '1 collecte');

      const forged = await L.A.postNotification(
        L.A.buildNotification(payment, { wrongKey: true }),
      );
      ok(forged.status === 401, `mauvaise clé : 401 (${forged.status})`);
      ok(
        (await L.sim.stats()).statusCalls === 0,
        'mauvaise clé : aucune consultation',
      );

      const early = await L.A.postNotification(L.A.buildNotification(payment));
      ok(
        early.status === 200 && early.body.received === true,
        'notification « SUCCESSFUL » acceptée (accusé)',
      );
      ok(
        (await dbPayments(o.orgId))[0].status === 'pending',
        'statut relu PENDING : rien attribué (déclencheur, jamais preuve)',
      );
      ok((await paymentPeriods(payment._id)) === 0, 'aucune période');

      await L.sim.settle(payment.providerReference, 'succeeded');
      const notification = L.A.buildNotification(payment);
      const first = await L.A.postNotification(notification);
      ok(
        first.status === 200 &&
          first.body.received === true &&
          first.cacheControl === 'no-store',
        `webhook : 200 (${first.status})`,
      );
      ok(
        (await dbPayments(o.orgId))[0].status === 'succeeded',
        'paiement confirmé (statut relu SUCCESSFUL)',
      );
      ok((await paymentPeriods(payment._id)) === 1, '1 période');
      const statusAfterFirst = (await L.sim.stats()).statusCalls;

      const replay = await L.A.postNotification(notification);
      ok(replay.status === 200, `rejeu : 200 (${replay.status})`);
      ok(
        (await paymentPeriods(payment._id)) === 1,
        'rejeu : toujours 1 période',
      );
      const statusAfterReplay = (await L.sim.stats()).statusCalls;

      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await page.waitForURL(`${WEB}/app`, { timeout: 20000 });
      const completes = requests.filter(
        (r) =>
          r.method === 'POST' &&
          r.url === `${API}/auth/subscription-access/complete`,
      );
      ok(
        completes.length === 1,
        'accès récupéré par l’échange `complete` existant',
      );
      const stats = await L.sim.stats();
      ok(
        stats.collectCalls === 1,
        `aucune seconde collecte (${stats.collectCalls})`,
      );
      ok((await paymentPeriods(payment._id)) === 1, 'toujours 1 période');
      return `401 mauvaise clé ; PENDING → rien ; SUCCESSFUL → 1 période ; rejeu → 1 période (consultations ${statusAfterFirst} → ${statusAfterReplay}) ; 1 collecte`;
    },
  );

  await scenario(
    'R1',
    'Initiation incertaine : inspection, simulation sans mutation, application, rejeu',
    'campay',
    async ({ page }) => {
      const { mongodbUri } = L.recipeState();
      const o = await L.registerOwner('reconcile');
      await loginApp(page, o.email);
      await openSubscription(page);
      await L.sim.queueInit('lost');
      await payUi(page);
      await waitStatus(page, 'uncertain');
      const [payment] = await dbPayments(o.orgId);
      const id = String(payment._id);
      ok(
        payment.status === 'uncertain' && payment.providerReference === null,
        'uncertain, aucune référence CamPay',
      );
      const tx = (await L.sim.stats()).transactions.find(
        (t) => t.merchantReference === payment.merchantReference,
      );
      ok(
        tx && tx.face === 'campay',
        'collecte présente chez le faux CamPay (relevé opérateur)',
      );
      await L.sim.settle(tx.providerReference, 'succeeded');
      const before = await L.D.counters(await L.db());

      const inspect = await L.A.runReconciliation('simulated', mongodbUri, [
        'inspect',
        `--payment-id=${id}`,
      ]);
      ok(
        inspect.code === 0 && inspect.json.command === 'inspect',
        `inspect : code ${inspect.code}`,
      );

      const real = await L.A.runReconciliation('real', mongodbUri, [
        'reconcile',
        `--payment-id=${id}`,
        `--reference=${tx.providerReference}`,
      ]);
      ok(
        real.code === 4 && real.json.plan.reason === 'provider-unavailable',
        `VRAI CLI bloqué : code ${real.code} ${real.json && real.json.plan && real.json.plan.reason}`,
      );
      const statusBefore = (await L.sim.stats()).statusCalls;
      ok(statusBefore === 0, 'VRAI CLI : aucune consultation');

      const simulation = await L.A.runReconciliation('simulated', mongodbUri, [
        'reconcile',
        `--payment-id=${id}`,
        `--reference=${tx.providerReference}`,
      ]);
      ok(
        simulation.code === 0 && simulation.json.mode === 'simulation',
        `simulation : code ${simulation.code}`,
      );
      const plan = simulation.json.plan;
      ok(
        plan.decision === 'ready' &&
          plan.action === 'succeed' &&
          plan.referenceAttach === true,
        `plan : ${plan.decision}/${plan.action}`,
      );
      const afterSimulation = await L.D.counters(await L.db());
      ok(
        JSON.stringify(afterSimulation) === JSON.stringify(before),
        'simulation : aucune mutation (compteurs)',
      );
      const unchanged = (await dbPayments(o.orgId))[0];
      ok(
        unchanged.status === 'uncertain' &&
          unchanged.providerReference === null,
        'simulation : paiement inchangé',
      );

      const operationId = crypto.randomUUID();
      const applyArgs = [
        'reconcile',
        `--payment-id=${id}`,
        `--reference=${tx.providerReference}`,
        '--apply',
        `--plan=${plan.planToken}`,
        `--operation-id=${operationId}`,
        '--operator=recette-locale',
        '--reason=uncertain-initiation',
        '--ticket=RECETTE-14D2H',
      ];
      const applied = await L.A.runReconciliation(
        'simulated',
        mongodbUri,
        applyArgs,
      );
      ok(
        applied.code === 0 && applied.json.result === 'applied',
        `application : code ${applied.code} ${applied.json && applied.json.result}`,
      );
      const after = (await dbPayments(o.orgId))[0];
      ok(
        after.status === 'succeeded' &&
          after.providerReference === tx.providerReference,
        'succeeded, référence rattachée',
      );
      ok(
        (await paymentPeriods(id)) === 1 && (await audits(id)) === 1,
        '1 période, 1 audit',
      );
      const statusAfterApply = (await L.sim.stats()).statusCalls;

      const replayed = await L.A.runReconciliation(
        'simulated',
        mongodbUri,
        applyArgs,
      );
      ok(
        replayed.code === 0 && replayed.json.result === 'replayed',
        `rejeu : code ${replayed.code} ${replayed.json && replayed.json.result}`,
      );
      ok(
        (await paymentPeriods(id)) === 1 && (await audits(id)) === 1,
        'rejeu : toujours 1 période, 1 audit',
      );
      ok(
        (await L.sim.stats()).statusCalls === statusAfterApply,
        'rejeu : aucune consultation',
      );

      const conflict = await L.A.runReconciliation(
        'simulated',
        mongodbUri,
        applyArgs.map((a) =>
          a.startsWith('--reason=') ? '--reason=provider-statement' : a,
        ),
      );
      ok(
        conflict.code === 6,
        `même identifiant, autre motif : code ${conflict.code}`,
      );
      ok((await audits(id)) === 1, 'conflit : aucun audit ajouté');

      await page.reload();
      await waitStatus(page, 'succeeded');
      ok((await L.sim.stats()).collectCalls === 1, 'aucune seconde collecte');
      return `inspect 0 ; vrai CLI 4 (provider-unavailable) ; simulation 0 sans mutation ; application 0 ; rejeu 0 (replayed) ; conflit 6 ; 1 collecte, 1 période, 1 audit`;
    },
  );

  await scenario(
    'R2',
    'Paiement en review : discordance bloquée, puis rapprochement concordant',
    'campay',
    async ({ page }) => {
      const { mongodbUri } = L.recipeState();
      const o = await L.registerOwner('review-rc');
      await loginApp(page, o.email);
      await openSubscription(page);
      await payUi(page);
      await waitStatus(page, 'pending');
      const [payment] = await dbPayments(o.orgId);
      const id = String(payment._id);
      await L.sim.settle(payment.providerReference, 'succeeded');
      await L.sim.queueStatus({ override: { amount: 2999 } });
      await page.getByRole('button', { name: 'Vérifier le paiement' }).click();
      await waitStatus(page, 'review');
      ok((await paymentPeriods(id)) === 0, 'review : aucune période');

      await L.sim.queueStatus({ override: { amount: 2999 } });
      const blocked = await L.A.runReconciliation('simulated', mongodbUri, [
        'reconcile',
        `--payment-id=${id}`,
      ]);
      ok(
        blocked.code === 4 && blocked.json.plan.reason === 'mismatch',
        `discordance : code ${blocked.code}`,
      );
      ok(
        (await dbPayments(o.orgId))[0].status === 'review',
        'discordance : review conservé',
      );

      const simulation = await L.A.runReconciliation('simulated', mongodbUri, [
        'reconcile',
        `--payment-id=${id}`,
      ]);
      ok(
        simulation.code === 0 && simulation.json.plan.action === 'succeed',
        `concordance : code ${simulation.code}`,
      );
      const applied = await L.A.runReconciliation('simulated', mongodbUri, [
        'reconcile',
        `--payment-id=${id}`,
        '--apply',
        `--plan=${simulation.json.plan.planToken}`,
        `--operation-id=${crypto.randomUUID()}`,
        '--operator=recette-locale',
        '--reason=review-investigation',
      ]);
      ok(
        applied.code === 0 && applied.json.result === 'applied',
        `application : code ${applied.code}`,
      );
      ok((await dbPayments(o.orgId))[0].status === 'succeeded', 'succeeded');
      ok(
        (await paymentPeriods(id)) === 1 && (await audits(id)) === 1,
        '1 période, 1 audit',
      );
      await page.reload();
      await waitStatus(page, 'succeeded');
      ok((await L.sim.stats()).collectCalls === 1, '1 collecte');
      return 'review discordant : 4, état conservé ; concordant : appliqué, 1 période, 1 audit, 1 collecte';
    },
  );

  fs.writeFileSync(
    path.join(L.outputDir(), 'results.json'),
    JSON.stringify(results, null, 2),
  );
  await L.close();
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(
    `\n${results.length - failed}/${results.length} PASS — résultats : ${L.outputDir()}`,
  );
  process.exit(failed ? 1 : 0);
})().catch(async (error) => {
  console.error(error);
  await L.close();
  process.exit(1);
});
