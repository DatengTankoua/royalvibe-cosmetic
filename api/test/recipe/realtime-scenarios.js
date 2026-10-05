/**
 * 1-15A — Campagne navigateur du temps réel fonctionnel (TEST).
 *
 * Réutilise la stack isolée 1-14D.2H (`recipe.js start`), ses fixtures
 * fictives et son outillage (`lib.js`). Les comptes de chaque scénario sont
 * créés par les routes publiques (inscription, invitation) ; les produits
 * par insertion directe dans la base éphémère (comme `lib.seedProduct`).
 *
 * Aucune attente arbitraire pour ORDONNER une course : les courses sont
 * pilotées par des barrières (`page.route` retenu jusqu'à libération) et
 * les vérifications attendent un effet observable (DOM, frame, requête).
 * Les seules attentes à durée fixe servent à prouver une ABSENCE (aucune
 * frame, aucune requête) pendant une fenêtre bornée.
 *
 * Lancement : node api/test/recipe/recipe.js realtime [ids...] --playwright=<dir> [--chromium=<exe>]
 * Résultats : `realtime-results.json` et captures d'échec dans `RECIPE_RESULTS_DIR`.
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const { WEB, API } = L;
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

/** Attente d'un effet observable (jamais d'ordonnancement par délai). */
async function until(check, message, timeout = 15000) {
  const start = Date.now();
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() - start > timeout)
      throw new Error(
        `Délai dépassé : ${typeof message === 'function' ? await message() : message}`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Fenêtre bornée pour prouver une absence. */
const observeFor = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Comptes, produits, actions API ─────────────────────────────────────────

async function apiLogin(email) {
  const res = await L.http('POST', '/auth/login', {
    body: { email, password: L.C.PASSWORD },
  });
  ok(res.status === 200 || res.status === 201, `login ${email} ${res.status}`);
  return res.body.access_token;
}

async function memberIdOf(ownerToken, email) {
  const res = await L.http('GET', '/organizations/members', {
    token: ownerToken,
  });
  ok(res.status === 200, `members ${res.status}`);
  const member = res.body.find((m) => m.user.email === email);
  ok(member, `membre ${email} introuvable`);
  return member.membershipId;
}

async function patchMember(ownerToken, email, body) {
  const id = await memberIdOf(ownerToken, email);
  const res = await L.http('PATCH', `/organizations/members/${id}`, {
    token: ownerToken,
    body,
  });
  ok(res.status === 200, `PATCH membre ${res.status} ${res.text}`);
}

let productSeq = 0;
async function seedNamedProduct(ownerToken, orgId, label, qty) {
  productSeq += 1;
  const { productId, sectionId } = await L.seedProduct(ownerToken, orgId, qty);
  const name = `RT ${label} ${Date.now().toString(36)}${productSeq}`;
  await (
    await L.db()
  )
    .collection('products')
    .updateOne({ _id: L.oid(productId) }, { $set: { name } });
  return { productId, sectionId, name };
}

async function apiSale(token, productId, quantity, extra = {}) {
  const body = {
    productId,
    quantity,
    salePrice: 400,
    clientOperationId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    ...extra,
  };
  const res = await L.http('POST', '/sales', { token, body });
  ok(
    res.status === 201 || res.status === 200,
    `vente ${res.status} ${res.text}`,
  );
  return { sale: res.body, body };
}

async function serverStock(productId) {
  const p = await (
    await L.db()
  )
    .collection('products')
    .findOne({ _id: L.oid(productId) });
  return p.remainingQuantity;
}

async function salesCount(productId) {
  return (await L.db())
    .collection('sales')
    .countDocuments({ productId: L.oid(productId) });
}

/** Organisation A (propriétaire + vendeurs) et organisation B. */
async function setupOrganizations() {
  const ownerA = await L.registerOwner('rtA');
  const std = await L.inviteMember(ownerA.token, 'seller', 'rtStd');
  const fin = await L.inviteMember(ownerA.token, 'seller', 'rtFin');
  await patchMember(ownerA.token, fin.email, {
    permissions: ['products.view_financials'],
  });
  const ownerB = await L.registerOwner('rtB');
  return { ownerA, std, fin, ownerB };
}

// ─── Navigateur ─────────────────────────────────────────────────────────────

/** Contexte isolé (stockage séparé) avec capture des frames Socket.IO. */
async function openUser(browser, label) {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const user = {
    label,
    context,
    page,
    frames: [],
    sockets: 0,
    requests: [],
    errors: [],
  };
  attach(user, page);
  return user;
}

function attach(user, page) {
  page.on('websocket', (ws) => {
    user.sockets += 1;
    ws.on('framereceived', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : '';
      const match = /^42(\[.*)$/s.exec(text);
      if (!match) return;
      try {
        const [event, payload] = JSON.parse(match[1]);
        user.frames.push({ event, payload, at: Date.now(), page });
      } catch {
        // frame non JSON
      }
    });
  });
  page.on('request', (r) => {
    if (r.url().startsWith(API))
      user.requests.push({ method: r.method(), url: r.url(), at: Date.now() });
  });
  page.on('pageerror', (e) => user.errors.push(String(e)));
}

async function loginUi(page, email) {
  await L.uiLogin(page, email);
  await page.waitForURL(`${WEB}/app`, { timeout: 20000 });
}

/** Repère posé dans la page : un rechargement complet le ferait disparaître. */
async function markNoReload(page) {
  await page.evaluate(() => {
    window.__rt15a = 'same-document';
  });
}
async function stillSameDocument(page) {
  return (await page.evaluate(() => window.__rt15a)) === 'same-document';
}

/** Valeurs de stock affichées (cartes et fiche) : libellé + valeur. */
async function stockItems(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('span, p')) {
      const t = el.textContent.trim();
      if (
        (t === 'Stock restant' || t === 'Stock indicatif') &&
        el.children.length === 0
      ) {
        out.push({
          label: t,
          value: (el.nextElementSibling?.textContent || '').trim(),
        });
      }
    }
    return out;
  });
}
const firstStock = async (page) => (await stockItems(page))[0] || null;

async function infoValue(page, label) {
  return page.evaluate((wanted) => {
    for (const el of document.querySelectorAll('span, p')) {
      if (el.children.length === 0 && el.textContent.trim() === wanted) {
        return (el.nextElementSibling?.textContent || '').trim();
      }
    }
    return null;
  }, label);
}

async function waitStock(page, expected, message, timeout) {
  return until(
    async () => {
      const s = await firstStock(page);
      return s && s.value === String(expected) && s.label === 'Stock restant'
        ? s
        : null;
    },
    async () =>
      `${message} (attendu ${expected}, vu ${JSON.stringify(await firstStock(page))})`,
    timeout,
  );
}

async function openSection(page, sectionId) {
  await page.goto(`${WEB}/app/catalog/${sectionId}`);
  await until(async () => (await stockItems(page)).length > 0, 'cartes');
}
async function openProduct(page, productId) {
  await page.goto(`${WEB}/app/catalog/products/${productId}`);
  await until(async () => (await stockItems(page)).length > 0, 'fiche');
}

/**
 * Barrière : retient les `max` premières réponses d'une URL (contenu lu au
 * serveur à l'arrivée de la requête) jusqu'à libération ; les suivantes
 * passent normalement.
 */
async function holdResponses(page, predicate, max = 1) {
  const held = [];
  let releaseAll = null;
  const gate = new Promise((r) => (releaseAll = r));
  let holding = true;
  const seen = [];
  await page.route(
    (url) => predicate(url.toString()),
    async (route) => {
      seen.push(Date.now());
      const response = await route.fetch();
      if (holding && held.length < max) {
        const entry = { url: route.request().url(), at: Date.now() };
        held.push(entry);
        await gate;
      }
      await route.fulfill({ response });
    },
  );
  return {
    held,
    seen,
    release: () => {
      holding = false;
      releaseAll();
    },
    stop: () => page.unroute(() => true).catch(() => {}),
  };
}

const saleFrames = (user, since = 0) =>
  user.frames.filter((f) => f.event.startsWith('sale:') && f.at >= since);
const businessFrames = (user, since = 0) =>
  user.frames.filter(
    (f) =>
      (f.event.startsWith('sale:') || f.event.startsWith('product:')) &&
      f.at >= since,
  );
const getsOf = (user, pattern, since = 0) =>
  user.requests.filter(
    (r) =>
      r.method === 'GET' &&
      pattern.test(new URL(r.url).pathname) &&
      r.at >= since,
  );

// 1-15B — sections par l'API (routes existantes, droits du jeton fourni).
async function apiSection(token, name, parentId) {
  const res = await L.http('POST', '/sections', {
    token,
    body: parentId ? { name, parentId } : { name },
  });
  ok(res.status === 201, `section ${res.status} ${res.text}`);
  return { _id: String(res.body._id), name };
}

async function apiRenameSection(token, id, name) {
  const res = await L.http('PATCH', `/sections/${id}`, {
    token,
    body: { name },
  });
  ok(res.status === 200, `renommage section ${res.status} ${res.text}`);
}

/** 1-15B — sentinelle : enregistre toute apparition du texte dans la page. */
async function armReappearance(page, text) {
  await page.evaluate((wanted) => {
    window.__rtReappeared = false;
    const check = () => {
      if (document.body.innerText.includes(wanted))
        window.__rtReappeared = true;
    };
    check();
    new MutationObserver(check).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }, text);
}
const reappeared = (page) =>
  page.evaluate(() => window.__rtReappeared === true);

/** Attend qu'aucune requête API de l'utilisateur ne parte pendant `ms`. */
async function waitQuiet(user, ms, timeout = 15000) {
  const start = Date.now();
  for (;;) {
    const last = user.requests.length
      ? user.requests[user.requests.length - 1].at
      : 0;
    if (Date.now() - last >= ms) return;
    if (Date.now() - start > timeout)
      throw new Error('Délai dépassé : page jamais au repos');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sectionFrames = (user, since = 0) =>
  user.frames.filter((f) => f.event.startsWith('section:') && f.at >= since);

// ─── 1-15C : aides membres, invitations, image de marque ────────────────────

const memberCard = (page, email) =>
  page.locator('[data-slot=card]').filter({ hasText: email }).first();
const invitationRow = memberCard;
const emptyPayload = (frame) =>
  frame.payload !== null &&
  typeof frame.payload === 'object' &&
  Object.keys(frame.payload).length === 0;

let invitationSeq = 0;
/** Invitation par la route existante ; e-mail simulé, lien local. */
async function apiInvite(token, label, role, permissions) {
  invitationSeq += 1;
  const email = `${label}-${Date.now().toString(36)}${invitationSeq}@recette.local`;
  const res = await L.http('POST', '/organizations/invitations', {
    token,
    body: permissions ? { email, role, permissions } : { email, role },
  });
  ok(res.status === 201, `invitation ${res.status} ${res.text}`);
  const link = new URL(res.body.invitationUrl);
  ok(link.origin === WEB, 'lien d’invitation local');
  return {
    id: String(res.body.invitation._id),
    email,
    rawToken: link.searchParams.get('token'),
  };
}

async function apiRevoke(token, id) {
  const res = await L.http('POST', `/organizations/invitations/${id}/revoke`, {
    token,
  });
  ok(res.status === 200 || res.status === 201, `révocation ${res.status}`);
}

async function apiAccept(rawToken, name) {
  const res = await L.http('POST', '/auth/invitations/accept', {
    body: { token: rawToken, name, password: L.C.PASSWORD },
  });
  ok(res.status === 200, `acceptation ${res.status} ${res.text}`);
}

/** Logo PNG factice local (validations de production inchangées). */
async function pngLogo(width, height, color) {
  const sharp = L.C.apiRequire('sharp');
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

/** `PATCH /organizations/current/branding` multipart (route existante). */
async function uploadBranding(token, { name, logo }) {
  const form = new FormData();
  if (name !== undefined) form.append('name', name);
  if (logo)
    form.append('logo', new Blob([logo], { type: 'image/png' }), 'logo.png');
  const res = await fetch(`${API}/organizations/current/branding`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  ok(res.status === 200, `branding ${res.status} ${text}`);
  return JSON.parse(text);
}

async function storageStats() {
  const res = await fetch(`${L.C.STORAGE_URL}/__stats`);
  return res.json();
}

const tenantName = (page) =>
  page
    .locator('[data-testid=tenant-name]')
    .first()
    .textContent({ timeout: 2000 })
    .then((t) => (t || '').trim())
    .catch(() => null);

/** Logo du shell : URL, chargement effectif et dimensions réelles. */
const logoState = (page) =>
  page.evaluate(() => {
    const img = document.querySelector('[data-tenant-logo=image] img');
    if (!img) return null;
    return {
      src: img.currentSrc || img.src,
      loaded: img.complete && img.naturalWidth > 0,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  });

const FORBIDDEN_KEYS = [
  'purchasePrice',
  'initialQuantity',
  'actualRevenue',
  'actualProfit',
  'margin',
  'totalPurchaseCost',
  'unitsSold',
  'buyerName',
  'buyerContact',
  'sellerId',
  'salePrice@sale',
];
function forbiddenKeysIn(frame) {
  const found = [];
  const walk = (value, prefix) => {
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k)) found.push(`${prefix}${k}`);
      walk(v, `${prefix}${k}.`);
    }
  };
  walk(frame.payload, '');
  if (frame.event.startsWith('sale:')) {
    const keys = Object.keys(frame.payload || {})
      .sort()
      .join(',');
    if (keys !== '_id,productId') found.push(`sale-keys:${keys}`);
  }
  return found;
}

// ─── Exécution ──────────────────────────────────────────────────────────────

async function scenario(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  const browser = await chromium.launch({ executablePath: loaded.executable });
  const t0 = Date.now();
  const ctx = { browser, users: [] };
  try {
    await L.restartApi('simulated');
    const notes = await fn(ctx);
    results.push({
      id,
      title,
      status: 'PASS',
      ms: Date.now() - t0,
      notes: notes || '',
    });
    console.log(`PASS ${id} ${title}${notes ? ' — ' + notes : ''}`);
  } catch (e) {
    results.push({
      id,
      title,
      status: 'FAIL',
      ms: Date.now() - t0,
      error: String(e && e.stack),
    });
    console.log(`FAIL ${id} ${title} — ${e && e.message}`);
    for (const u of ctx.users) {
      try {
        await u.page.screenshot({
          path: path.join(L.outputDir(), `rt-fail-${id}-${u.label}.png`),
          fullPage: true,
        });
      } catch {
        // capture facultative
      }
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  // RT1 — même organisation : vente d'un collègue, modification, suppression.
  await scenario(
    'RT1',
    'Même organisation : ventes et produits d’un collègue sans rechargement',
    async (ctx) => {
      const { ownerA, std, fin } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt1', 50);
      const tStd = await apiLogin(std.email);

      const owner = await openUser(ctx.browser, 'owner');
      const cards = await openUser(ctx.browser, 'std-cards');
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      const salesView = await openUser(ctx.browser, 'owner-sales');
      ctx.users.push(owner, cards, sheet, salesView);
      await loginUi(owner.page, ownerA.email);
      await loginUi(cards.page, std.email);
      await loginUi(sheet.page, fin.email);
      await loginUi(salesView.page, ownerA.email);
      await openProduct(owner.page, p.productId);
      await openSection(cards.page, p.sectionId);
      await openProduct(sheet.page, p.productId);
      await salesView.page.goto(`${WEB}/app/sales`);
      await salesView.page.getByText('Aucune vente enregistrée').waitFor();
      for (const u of [owner, cards, sheet, salesView])
        await markNoReload(u.page);
      ok(
        (await infoValue(sheet.page, 'CA réel')) !== null,
        'finances visibles',
      );

      // a) Vente du propriétaire par l'interface (fiche).
      await owner.page
        .getByRole('button', { name: 'Enregistrer une vente' })
        .click();
      await owner.page.fill('#s-qty', '2');
      await owner.page.fill('#s-buyer', 'Acheteur RT1');
      await owner.page.fill('#s-contact', '+237600000001');
      await owner.page
        .getByRole('button', { name: 'Confirmer la vente' })
        .click();
      await owner.page
        .getByText('Vente enregistrée', { exact: true })
        .first()
        .waitFor();
      await waitStock(cards.page, 48, 'cartes du vendeur standard après vente');
      await waitStock(sheet.page, 48, 'fiche du vendeur finances après vente');
      await until(
        async () => (await infoValue(sheet.page, 'CA réel'))?.includes('800'),
        'CA réel 800',
      );
      // Aucune double déduction chez l'auteur : stock serveur après confirmation.
      await waitStock(
        owner.page,
        48,
        'fiche de l’auteur (aucune double déduction)',
      );
      ok((await serverStock(p.productId)) === 48, 'stock serveur 48');
      await salesView.page
        .getByText('Acheteur RT1')
        .first()
        .waitFor({ timeout: 15000 });

      // b) Vente d'un collègue par l'API (vendeur standard), puis modification et suppression.
      const { sale } = await apiSale(tStd, p.productId, 3, {
        buyerName: 'Acheteur Std',
      });
      await waitStock(sheet.page, 45, 'fiche après vente du collègue');
      await waitStock(cards.page, 45, 'cartes après vente du collègue');
      await salesView.page
        .getByText('Acheteur Std')
        .first()
        .waitFor({ timeout: 15000 });
      const patched = await L.http('PATCH', `/sales/${sale._id}`, {
        token: tStd,
        body: { quantity: 1 },
      });
      ok(patched.status === 200, `PATCH vente ${patched.status}`);
      await waitStock(sheet.page, 47, 'fiche après modification de vente');
      await waitStock(cards.page, 47, 'cartes après modification de vente');
      const removed = await L.http('DELETE', `/sales/${sale._id}`, {
        token: tStd,
      });
      ok([200, 204].includes(removed.status), `DELETE vente ${removed.status}`);
      await waitStock(sheet.page, 48, 'fiche après suppression de vente');
      await until(
        async () =>
          (await salesView.page.getByText('Acheteur Std').count()) === 0,
        'vente supprimée retirée de la liste des ventes',
      );

      // c) Modification du produit (stock ajouté) puis mise à la corbeille.
      const upd = await L.http('PATCH', `/products/${p.productId}`, {
        token: ownerA.token,
        body: { additionalStock: 10, salePrice: 450 },
      });
      ok(upd.status === 200, `PATCH produit ${upd.status} ${upd.text}`);
      await waitStock(cards.page, 58, 'cartes après ajout de stock');
      await waitStock(sheet.page, 58, 'fiche après ajout de stock');
      await until(
        async () =>
          (await infoValue(sheet.page, 'Prix de vente cible'))?.includes('450'),
        'prix cible fiche 450',
      );
      const del = await L.http('DELETE', `/products/${p.productId}`, {
        token: ownerA.token,
      });
      ok(del.status === 200, `DELETE produit ${del.status}`);
      await until(
        async () => (await cards.page.getByText(p.name).count()) === 0,
        'carte retirée',
      );
      await until(
        async () => (await stockItems(sheet.page)).length === 0,
        'fiche : produit retiré',
      );

      for (const u of [owner, cards, sheet, salesView])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      for (const u of [cards, sheet])
        for (const f of businessFrames(u)) {
          const bad = forbiddenKeysIn(f);
          ok(bad.length === 0, `${u.label} ${f.event} : ${bad.join(',')}`);
        }
      return `cartes/fiche 50→48→45→47→48→58→retiré ; frames vente = {_id, productId}`;
    },
  );

  // RT2 — seconde organisation : aucune réception, aucune contamination.
  await scenario(
    'RT2',
    'Seconde organisation : aucune frame ni donnée de A',
    async (ctx) => {
      const { ownerA, std, ownerB } = await setupOrganizations();
      const pA = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt2A', 20);
      const pB = await seedNamedProduct(ownerB.token, ownerB.orgId, 'rt2B', 20);
      const tStd = await apiLogin(std.email);
      const b = await openUser(ctx.browser, 'ownerB');
      const a = await openUser(ctx.browser, 'stdA');
      ctx.users.push(a, b);
      await loginUi(b.page, ownerB.email);
      await loginUi(a.page, std.email);
      await openSection(b.page, pB.sectionId);
      await openSection(a.page, pA.sectionId);
      const since = Date.now();
      await apiSale(tStd, pA.productId, 2);
      await waitStock(a.page, 18, 'organisation A actualisée');
      await observeFor(1500);
      ok(
        businessFrames(b, since).length === 0,
        `B a reçu ${businessFrames(b, since).length} frame(s)`,
      );
      ok(getsOf(b, /\/products/, since).length === 0, 'B : aucune relecture');
      ok(
        (await b.page.getByText(pA.name).count()) === 0,
        'B : aucun produit de A',
      );
      await waitStock(b.page, 20, 'B inchangé');
      return 'B : 0 frame, 0 relecture, stock 20 inchangé';
    },
  );

  // RT3 — permissions retirées puis rendues, suspension en session ouverte.
  await scenario(
    'RT3',
    'Droits modifiés et suspension pendant une session ouverte',
    async (ctx) => {
      const { ownerA, std, fin } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt3', 30);
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      const cards = await openUser(ctx.browser, 'std-cards');
      ctx.users.push(sheet, cards);
      await loginUi(sheet.page, fin.email);
      await loginUi(cards.page, std.email);
      await openProduct(sheet.page, p.productId);
      await openSection(cards.page, p.sectionId);
      await markNoReload(sheet.page);
      await markNoReload(cards.page);
      ok(
        (await infoValue(sheet.page, 'CA réel')) !== null,
        'CA réel visible au départ',
      );

      // a) Retrait des finances : données retirées, contexte relu.
      await patchMember(ownerA.token, fin.email, { permissions: [] });
      await until(
        async () => (await infoValue(sheet.page, 'CA réel')) === null,
        'CA réel retiré sans rechargement',
      );
      ok(
        (await infoValue(sheet.page, "Prix d'achat unitaire")) === null,
        'prix d’achat retiré',
      );
      const html = await sheet.page.content();
      ok(
        !/CA réel|Prix d'achat|Coût total/.test(html),
        'aucun libellé financier dans le DOM',
      );

      // b) Le temps réel reprend après la déconnexion serveur.
      const since = Date.now();
      await apiSale(ownerA.token, p.productId, 2);
      await waitStock(
        sheet.page,
        28,
        'fiche actualisée après retrait des droits (socket rouvert)',
      );
      for (const f of businessFrames(sheet, since)) {
        const bad = forbiddenKeysIn(f);
        ok(bad.length === 0, `${f.event} : ${bad.join(',')}`);
      }
      // c) Droits rendus : finances de retour sans rechargement.
      await patchMember(ownerA.token, fin.email, {
        permissions: ['products.view_financials'],
      });
      await until(
        async () => (await infoValue(sheet.page, 'CA réel')) !== null,
        'CA réel rendu',
      );
      ok(
        await stillSameDocument(sheet.page),
        'fiche : aucun rechargement complet',
      );

      // d) Suspension du vendeur standard : données retirées, plus d'accès.
      await patchMember(ownerA.token, std.email, { status: 'suspended' });
      await until(
        async () => (await cards.page.getByText(p.name).count()) === 0,
        'catalogue retiré après suspension',
      );
      const suspendedSince = Date.now();
      await apiSale(ownerA.token, p.productId, 1);
      await observeFor(1500);
      ok(
        businessFrames(cards, suspendedSince).length === 0,
        'suspendu : aucune frame',
      );
      ok(
        (await stockItems(cards.page)).length === 0,
        'suspendu : aucun stock affiché',
      );
      return 'finances retirées/rendues sans rechargement, socket rouvert, suspension : catalogue retiré, 0 frame';
    },
  );

  // RT4 — changement d'identité/organisation avec requêtes et événements en cours.
  await scenario(
    'RT4',
    'Changement d’organisation avec requête retenue et autre onglet',
    async (ctx) => {
      const { ownerA, std, ownerB } = await setupOrganizations();
      const pA = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt4A', 20);
      const pB = await seedNamedProduct(ownerB.token, ownerB.orgId, 'rt4B', 20);
      const tStd = await apiLogin(std.email);

      // a) Même onglet : réponse de A retenue, déconnexion, connexion B, libération.
      const u = await openUser(ctx.browser, 'switcher');
      ctx.users.push(u);
      await loginUi(u.page, std.email);
      await openSection(u.page, pA.sectionId);
      const barrier = await holdResponses(u.page, (url) =>
        url.startsWith(`${API}/products`),
      );
      const since = Date.now();
      await apiSale(tStd, pA.productId, 1); // invalidation → relecture retenue
      await until(() => barrier.held.length > 0, 'relecture retenue');
      await u.page
        .getByRole('button', { name: 'Se déconnecter' })
        .first()
        .click();
      await u.page.waitForURL(/\/auth\/login/);
      await loginUi(u.page, ownerB.email);
      await openSection(u.page, pB.sectionId);
      barrier.release();
      await apiSale(tStd, pA.productId, 1);
      await observeFor(1500);
      ok(
        (await u.page.getByText(pA.name).count()) === 0,
        'aucun produit de A après passage à B',
      );
      await waitStock(u.page, 20, 'B affiché');
      ok(
        businessFrames(u, since).filter(
          (f) =>
            f.payload &&
            f.payload.productId === pA.productId &&
            f.at > barrier.held[0].at + 1,
        ).length <= 1,
        'événements de A non reçus après passage à B',
      );
      await barrier.stop();

      // b) Deux onglets du même navigateur : l'autre onglet change de session.
      const shared = await openUser(ctx.browser, 'tab1');
      ctx.users.push(shared);
      await loginUi(shared.page, std.email);
      await openSection(shared.page, pA.sectionId);
      const tab2 = await shared.context.newPage();
      attach(shared, tab2);
      await loginUi(tab2, ownerB.email);
      const tabSince = Date.now();
      await apiSale(tStd, pA.productId, 1);
      // Onglet 1 : jamais l'en-tête de A avec des données relues avec le jeton B.
      await until(async () => {
        const name = await shared.page
          .locator('[data-testid=tenant-name]')
          .first()
          .textContent()
          .catch(() => null);
        return name && name.includes('Shop rtB');
      }, 'onglet 1 : session B adoptée (en-tête B)');
      ok(
        (await shared.page.getByText(pA.name).count()) === 0,
        'onglet 1 : plus de produit de A',
      );
      const lateFrames = businessFrames(shared, tabSince + 2000).filter(
        (f) =>
          f.page === shared.page &&
          f.payload &&
          f.payload.productId === pA.productId,
      );
      ok(
        lateFrames.length === 0,
        'onglet 1 : aucun événement de A après adoption de B',
      );
      return 'réponse retenue de A ignorée ; autre onglet : session B adoptée, aucune donnée de A';
    },
  );

  // RT5 — coupure réseau, mutations pendant la coupure, reconnexion.
  await scenario(
    'RT5',
    'Coupure réseau puis reconnexion : rattrapage',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt5', 40);
      const cards = await openUser(ctx.browser, 'std-cards');
      const sheet = await openUser(ctx.browser, 'owner-sheet');
      ctx.users.push(cards, sheet);
      await loginUi(cards.page, std.email);
      await loginUi(sheet.page, ownerA.email);
      await openSection(cards.page, p.sectionId);
      await openProduct(sheet.page, p.productId);
      await markNoReload(sheet.page);

      await cards.context.setOffline(true);
      await sheet.context.setOffline(true);
      await cards.page.getByText('Vous êtes hors connexion').first().waitFor();
      await apiSale(ownerA.token, p.productId, 2);
      await apiSale(ownerA.token, p.productId, 3);
      const upd = await L.http('PATCH', `/products/${p.productId}`, {
        token: ownerA.token,
        body: { salePrice: 470 },
      });
      ok(upd.status === 200, 'PATCH produit');
      await sheet.context.setOffline(false);
      await cards.context.setOffline(false);
      await waitStock(sheet.page, 35, 'fiche rattrapée après reconnexion');
      await until(
        async () =>
          (await infoValue(sheet.page, 'Prix de vente cible'))?.includes('470'),
        'prix rattrapé',
      );
      // Cartes : la page catalogue hors ligne est remplacée par le catalogue en ligne.
      await openSection(cards.page, p.sectionId);
      await waitStock(cards.page, 35, 'cartes après reconnexion');
      ok(
        await stillSameDocument(sheet.page),
        'fiche : aucun rechargement complet',
      );
      return 'fiche : 40 → 35 et prix 470 rattrapés au retour du réseau';
    },
  );

  // RT6 — regroupement et invalidation arrivée pendant un chargement.
  await scenario(
    'RT6',
    'Regroupement, invalidation pendant chargement, réponse périmée',
    async (ctx) => {
      const { ownerA, fin } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt6', 60);
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      ctx.users.push(sheet);
      await loginUi(sheet.page, fin.email);
      await openProduct(sheet.page, p.productId);
      const productPath = new RegExp(`/products/${p.productId}$`);

      // a) Rafale : 5 ventes → relectures regroupées, valeur finale exacte.
      const burstSince = Date.now();
      await Promise.all(
        [1, 2, 3, 4, 5].map(() => apiSale(ownerA.token, p.productId, 1)),
      );
      await waitStock(sheet.page, 55, 'rafale reflétée');
      await observeFor(1200);
      const burstGets = getsOf(sheet, productPath, burstSince).length;
      ok(burstGets <= 2, `rafale : ${burstGets} relectures (≤ 2 attendues)`);

      // b) Invalidation pendant un chargement retenu, puis réponse périmée.
      const barrier = await holdResponses(sheet.page, (url) =>
        productPath.test(new URL(url).pathname),
      );
      await apiSale(ownerA.token, p.productId, 2); // → 53 ; relecture R1 retenue (contenu 53)
      await until(() => barrier.held.length >= 1, 'relecture R1 retenue');
      await apiSale(ownerA.token, p.productId, 4); // → 49 pendant R1
      // Avant correctif : une seconde relecture part en parallèle, passe
      // (contenu 49), puis la réponse retenue (53) arrive en dernier.
      await observeFor(1500);
      const parallel = barrier.seen.length;
      barrier.release();
      await waitStock(
        sheet.page,
        49,
        'invalidation arrivée pendant le chargement conservée',
      );
      await observeFor(1000);
      const finalStock = await firstStock(sheet.page);
      ok(
        finalStock.value === '49',
        `réponse périmée appliquée en dernier : ${finalStock.value}`,
      );
      await barrier.stop();
      return `rafale : ${burstGets} relecture(s) ; requêtes simultanées pendant la barrière : ${parallel}`;
    },
  );

  // RT7 — vente issue de l'outbox, rejeu idempotent, aucun doublon.
  await scenario(
    'RT7',
    'Vente hors ligne synchronisée, rejeu idempotent, aucun doublon',
    async (ctx) => {
      const { ownerA, std, fin } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt7', 25);
      const seller = await openUser(ctx.browser, 'std-offline');
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      ctx.users.push(seller, sheet);
      await loginUi(seller.page, std.email);
      await loginUi(sheet.page, fin.email);
      await openProduct(seller.page, p.productId);
      await openProduct(sheet.page, p.productId);
      // Vente saisie pendant une coupure de l'API (méthode D.2H, scénario 11) :
      // le POST n'atteint jamais le serveur, la vente reste dans l'outbox.
      const salesUrl = `${API}/sales`;
      await seller.page.route(salesUrl, (route) =>
        route.request().method() === 'POST'
          ? route.abort('internetdisconnected')
          : route.continue(),
      );
      await seller.page
        .getByRole('button', { name: 'Enregistrer une vente' })
        .first()
        .click();
      await seller.page.fill('#s-qty', '3');
      await seller.page
        .getByRole('button', { name: 'Confirmer la vente' })
        .click();
      const ops = await until(async () => {
        const o = await L.outboxOps(seller.page);
        return o && o.ops.length === 1 && o.ops[0].status === 'pending'
          ? o.ops
          : null;
      }, 'vente en attente dans l’outbox');
      ok(
        (await salesCount(p.productId)) === 0,
        'aucune vente serveur avant reprise',
      );
      const opId = ops[0].clientOperationId;
      const since = Date.now();
      await seller.page.unroute(salesUrl);
      // Reprise : même déclencheur que le retour du réseau.
      await seller.page.evaluate(() =>
        window.dispatchEvent(new Event('online')),
      );
      await until(
        async () => (await salesCount(p.productId)) === 1,
        'vente synchronisée',
        60000,
      );
      await waitStock(sheet.page, 22, 'observateur : une seule déduction');
      // Rejeu de la même opération : aucune nouvelle vente ni événement.
      const tStd = await apiLogin(std.email);
      const op = ops[0];
      const replaySince = Date.now();
      const replay = await L.http('POST', '/sales', {
        token: tStd,
        body: {
          ...op.payload,
          clientOperationId: opId,
          occurredAt: op.occurredAt || op.payload.occurredAt,
        },
      });
      ok(
        [200, 201].includes(replay.status),
        `rejeu ${replay.status} ${replay.text}`,
      );
      await observeFor(1500);
      ok((await salesCount(p.productId)) === 1, 'une seule vente serveur');
      ok(
        saleFrames(sheet, replaySince).length === 0,
        'rejeu : aucun événement',
      );
      ok(
        saleFrames(sheet, since).length === 1,
        `événements de vente : ${saleFrames(sheet, since).length}`,
      );
      ok((await serverStock(p.productId)) === 22, 'stock serveur 22');
      // Vendeur : confirmation puis relecture réussie → aucune double déduction
      // (« Stock restant » 22, pas « Stock indicatif » 19), sans rechargement.
      await waitStock(
        seller.page,
        22,
        'vendeur : stock serveur sans double déduction',
      );
      await openSection(seller.page, p.sectionId);
      await waitStock(
        seller.page,
        22,
        'vendeur : cartes sans double déduction',
      );
      return `1 vente, 1 événement, rejeu sans événement ; stock 25 → 22 partout`;
    },
  );

  // RT8 — Analyse : la vente d'un collègue actualise les indicateurs autorisés.
  await scenario(
    'RT8',
    'Analyse : vente d’un collègue sans rechargement',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt8', 30);
      const tStd = await apiLogin(std.email);
      const owner = await openUser(ctx.browser, 'owner-analytics');
      const seller = await openUser(ctx.browser, 'std-analytics');
      ctx.users.push(owner, seller);
      await loginUi(owner.page, ownerA.email);
      await loginUi(seller.page, std.email);
      await owner.page.goto(`${WEB}/app/analytics`);
      await until(
        async () => (await infoValue(owner.page, 'Transactions')) === '0',
        'Transactions 0',
      );
      ok(
        (await infoValue(owner.page, 'Unités vendues')) === '0',
        'Unités vendues 0',
      );
      await seller.page.goto(`${WEB}/app/analytics`);
      await seller.page
        .getByText('pas la permission de consulter les analyses')
        .waitFor();
      await markNoReload(owner.page);
      const since = Date.now();
      await apiSale(tStd, p.productId, 2, { buyerName: 'Acheteur RT8' });
      await until(
        async () => (await infoValue(owner.page, 'Transactions')) === '1',
        'Transactions 1 sans rechargement',
      );
      await until(
        async () => (await infoValue(owner.page, 'Unités vendues')) === '2',
        'Unités vendues 2',
      );
      await until(
        async () =>
          (await infoValue(owner.page, "Chiffre d'affaires"))?.includes('800'),
        "Chiffre d'affaires 800",
      );
      ok(
        await stillSameDocument(owner.page),
        'analyse : aucun rechargement complet',
      );
      // Une seconde vente rapprochée : valeurs finales exactes.
      await apiSale(tStd, p.productId, 1);
      await until(
        async () => (await infoValue(owner.page, 'Transactions')) === '2',
        'Transactions 2',
      );
      // Membre sans `analytics.read` : aucune requête d'analyse, même après les ventes.
      await observeFor(1000);
      ok(
        getsOf(seller, /^\/analytics\//, 0).length === 0,
        'vendeur : aucune requête /analytics',
      );
      ok(
        (await infoValue(seller.page, 'Transactions')) === null,
        'vendeur : aucun indicateur',
      );
      ok(
        (await owner.page.content()).includes('Acheteur RT8') === false,
        'aucune donnée acheteur dans l’analyse',
      );
      const relus = getsOf(owner, /^\/analytics\/overview$/, since).length;
      return `Transactions 0→1→2, unités 0→2, CA 800 ; ${relus} relecture(s) overview ; vendeur : 0 requête /analytics`;
    },
  );

  // RT9 — Corbeille : mise à la corbeille puis restauration par un collègue.
  await scenario(
    'RT9',
    'Corbeille : mise à la corbeille et restauration par un collègue',
    async (ctx) => {
      const { ownerA } = await setupOrganizations();
      const admin = await L.inviteMember(ownerA.token, 'admin', 'rtAdm');
      const tAdmin = await apiLogin(admin.email);
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt9', 12);
      const owner = await openUser(ctx.browser, 'owner-trash');
      ctx.users.push(owner);
      await loginUi(owner.page, ownerA.email);
      await owner.page.goto(`${WEB}/app/trash`);
      await owner.page.getByText('Aucun produit dans la corbeille.').waitFor();
      await markNoReload(owner.page);
      const del = await L.http('DELETE', `/products/${p.productId}`, {
        token: tAdmin,
      });
      ok(del.status === 200, `DELETE produit ${del.status}`);
      await owner.page.getByText(p.name).first().waitFor({ timeout: 15000 });
      const res = await L.http('PATCH', `/products/${p.productId}/restore`, {
        token: tAdmin,
      });
      ok(res.status === 200, `restauration ${res.status}`);
      await until(
        async () => (await owner.page.getByText(p.name).count()) === 0,
        'produit retiré de la corbeille après restauration',
      );
      await owner.page.getByText('Aucun produit dans la corbeille.').waitFor();
      ok(
        await stillSameDocument(owner.page),
        'corbeille : aucun rechargement complet',
      );
      return 'produit apparu à la mise à la corbeille, retiré à la restauration, sans rechargement';
    },
  );

  // ─── 1-15B : sections et suppression définitive ────────────────────────────

  // RT10 — opérations de section d'un collègue : listes, filtre, en-tête,
  // sous-catalogues, corbeille, restauration, suppression définitive.
  await scenario(
    'RT10',
    'Sections : création, renommage, filtre, corbeille, restauration, suppression définitive',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const admin = await L.inviteMember(ownerA.token, 'admin', 'rtAdm10');
      const tAdmin = await apiLogin(admin.email);
      const tag = Date.now().toString(36);
      const parent = await apiSection(ownerA.token, `RT10 Parent ${tag}`);
      const target = await apiSection(ownerA.token, `RT10 Cible ${tag}`);

      const root = await openUser(ctx.browser, 'std-root');
      const sub = await openUser(ctx.browser, 'std-parent');
      const head = await openUser(ctx.browser, 'std-section');
      const trash = await openUser(ctx.browser, 'admin-trash');
      ctx.users.push(root, sub, head, trash);
      for (const [u, email] of [
        [root, std.email],
        [sub, std.email],
        [head, std.email],
        [trash, admin.email],
      ])
        await loginUi(u.page, email);
      await root.page.goto(`${WEB}/app/catalog`);
      await root.page.getByText(target.name).first().waitFor();
      await sub.page.goto(`${WEB}/app/catalog/${parent._id}`);
      await sub.page.getByText('Ce catalogue est vide.').waitFor();
      await head.page.goto(`${WEB}/app/catalog/${target._id}`);
      await head.page.getByRole('heading', { name: target.name }).waitFor();
      await trash.page.goto(`${WEB}/app/trash`);
      await trash.page
        .getByText('Aucun catalogue dans la corbeille.')
        .waitFor();
      for (const u of [root, sub, head, trash]) await markNoReload(u.page);

      // a) Création d'une section racine et d'un sous-catalogue.
      const created = await apiSection(ownerA.token, `RT10 Nouvelle ${tag}`);
      await root.page
        .getByText(created.name)
        .first()
        .waitFor({ timeout: 15000 });
      const child = await apiSection(
        ownerA.token,
        `RT10 Enfant ${tag}`,
        parent._id,
      );
      await sub.page.getByText(child.name).first().waitFor({ timeout: 15000 });

      // b) Filtre actif sur la liste racine : un renommage le fait entrer
      //    puis sortir des résultats.
      await root.page.fill(
        'input[placeholder="Rechercher un catalogue…"]',
        `zeta${tag}`,
      );
      await root.page.getByText(`Aucun résultat pour « zeta${tag} »`).waitFor();
      await apiRenameSection(ownerA.token, target._id, `Zeta${tag} renommée`);
      await root.page
        .getByText(`Zeta${tag} renommée`)
        .first()
        .waitFor({ timeout: 15000 });
      await head.page
        .getByRole('heading', { name: `Zeta${tag} renommée` })
        .waitFor({ timeout: 15000 });
      await apiRenameSection(ownerA.token, target._id, `RT10 Cible2 ${tag}`);
      await root.page
        .getByText(`Aucun résultat pour « zeta${tag} »`)
        .waitFor({ timeout: 15000 });
      await root.page.fill('input[placeholder="Rechercher un catalogue…"]', '');
      await root.page
        .getByText(`RT10 Cible2 ${tag}`)
        .first()
        .waitFor({ timeout: 15000 });

      // c) Mise à la corbeille : retirée de la liste, signalée sur sa page,
      //    ajoutée à la corbeille de l'administrateur.
      const del = await L.http('DELETE', `/sections/${target._id}`, {
        token: ownerA.token,
      });
      ok(del.status === 200, `DELETE section ${del.status}`);
      await until(
        async () =>
          (await root.page.getByText(`RT10 Cible2 ${tag}`).count()) === 0,
        'section retirée de la liste racine',
      );
      await head.page
        .getByText('Ce catalogue a été placé dans la corbeille.')
        .waitFor({ timeout: 15000 });
      await trash.page
        .getByText(`RT10 Cible2 ${tag}`)
        .first()
        .waitFor({ timeout: 15000 });

      // d) Restauration : de retour dans la liste, plus dans la corbeille.
      const res = await L.http('PATCH', `/sections/${target._id}/restore`, {
        token: tAdmin,
      });
      ok(res.status === 200, `restauration section ${res.status}`);
      await root.page
        .getByText(`RT10 Cible2 ${tag}`)
        .first()
        .waitFor({ timeout: 15000 });
      await until(
        async () =>
          (await head.page
            .getByText('Ce catalogue a été placé dans la corbeille.')
            .count()) === 0,
        'page de la section : bandeau retiré après restauration',
      );
      await trash.page
        .getByText('Aucun catalogue dans la corbeille.')
        .waitFor({ timeout: 15000 });

      // e) Corbeille puis suppression définitive du sous-catalogue.
      ok(
        (
          await L.http('DELETE', `/sections/${child._id}`, {
            token: ownerA.token,
          })
        ).status === 200,
        'corbeille enfant',
      );
      await until(
        async () => (await sub.page.getByText(child.name).count()) === 0,
        'enfant retiré du parent',
      );
      await trash.page
        .getByText(child.name)
        .first()
        .waitFor({ timeout: 15000 });
      const purge = await L.http('DELETE', `/sections/${child._id}/permanent`, {
        token: tAdmin,
      });
      ok(purge.status === 200, `purge section ${purge.status}`);
      await until(
        async () => (await trash.page.getByText(child.name).count()) === 0,
        'enfant retiré de la corbeille',
      );

      for (const u of [root, sub, head, trash])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      for (const u of [root, sub, head])
        for (const f of sectionFrames(u)) {
          const keys = Object.keys(f.payload || {})
            .sort()
            .join(',');
          ok(keys === '_id,parentId', `${f.event} : clés ${keys}`);
        }
      return 'création, sous-catalogue, filtre, en-tête, corbeille, restauration, purge : visibles sans rechargement ; frames {_id, parentId}';
    },
  );

  // RT11 — suppression définitive d'un produit : corbeille et fiche ouverte.
  await scenario(
    'RT11',
    'Produit supprimé définitivement : corbeille et fiche ouverte',
    async (ctx) => {
      const { ownerA, fin, std } = await setupOrganizations();
      const admin = await L.inviteMember(ownerA.token, 'admin', 'rtAdm11');
      const tAdmin = await apiLogin(admin.email);
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt11', 9);
      const trash = await openUser(ctx.browser, 'admin-trash');
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      const noTrash = await openUser(ctx.browser, 'std-trash');
      ctx.users.push(trash, sheet, noTrash);
      await loginUi(trash.page, admin.email);
      await loginUi(sheet.page, fin.email);
      await loginUi(noTrash.page, std.email);
      await trash.page.goto(`${WEB}/app/trash`);
      await trash.page.getByText('Aucun produit dans la corbeille.').waitFor();
      await openProduct(sheet.page, p.productId);
      await noTrash.page.goto(`${WEB}/app/trash`);
      await noTrash.page
        .getByText('pas la permission de gérer la corbeille')
        .waitFor();
      for (const u of [trash, sheet]) await markNoReload(u.page);

      ok(
        (
          await L.http('DELETE', `/products/${p.productId}`, {
            token: ownerA.token,
          })
        ).status === 200,
        'corbeille',
      );
      await trash.page.getByText(p.name).first().waitFor({ timeout: 15000 });
      await sheet.page
        .getByText('Ce produit a été placé dans la corbeille.')
        .waitFor({ timeout: 15000 });
      const since = Date.now();
      const purge = await L.http(
        'DELETE',
        `/products/${p.productId}/permanent`,
        { token: tAdmin },
      );
      ok(purge.status === 200, `purge produit ${purge.status}`);
      await until(
        async () => (await trash.page.getByText(p.name).count()) === 0,
        'produit retiré de la corbeille',
      );
      await trash.page.getByText('Aucun produit dans la corbeille.').waitFor();
      await sheet.page
        .getByText('Ce produit a été supprimé définitivement.')
        .waitFor({ timeout: 15000 });
      ok(
        (await sheet.page.getByText('placé dans la corbeille').count()) === 0,
        'fiche : plus présenté comme restaurable',
      );
      await observeFor(1000);
      ok(
        getsOf(noTrash, /^\/trash$/, 0).length === 0,
        'sans trash.manage : aucune requête /trash',
      );
      for (const f of sheet.frames.filter(
        (x) => x.event === 'product:purged' && x.at >= since,
      )) {
        const keys = Object.keys(f.payload || {})
          .sort()
          .join(',');
        ok(keys === '_id', `product:purged : clés ${keys}`);
      }
      ok(
        sheet.frames.some((x) => x.event === 'product:purged' && x.at >= since),
        'événement product:purged reçu',
      );
      for (const u of [trash, sheet])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      return 'corbeille vidée, fiche « supprimé définitivement », frame {_id} ; sans trash.manage : 0 requête';
    },
  );

  // RT12 — réponses retenues avant la suppression définitive.
  await scenario(
    'RT12',
    'Réponse retenue avant suppression définitive : aucune réapparition',
    async (ctx) => {
      const { ownerA, fin } = await setupOrganizations();
      const admin = await L.inviteMember(ownerA.token, 'admin', 'rtAdm12');
      const tAdmin = await apiLogin(admin.email);
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt12', 9);
      const trash = await openUser(ctx.browser, 'admin-trash');
      const sheet = await openUser(ctx.browser, 'fin-sheet');
      ctx.users.push(trash, sheet);
      await loginUi(trash.page, admin.email);
      await loginUi(sheet.page, fin.email);
      await trash.page.goto(`${WEB}/app/trash`);
      await trash.page.getByText('Aucun produit dans la corbeille.').waitFor();
      await openProduct(sheet.page, p.productId);

      // Fiche : relecture retenue (contenu : produit actif), puis corbeille et purge.
      const productPath = new RegExp(`/products/${p.productId}$`);
      const sheetBarrier = await holdResponses(sheet.page, (url) =>
        productPath.test(new URL(url).pathname),
      );
      ok(
        (
          await L.http('PATCH', `/products/${p.productId}`, {
            token: ownerA.token,
            body: { salePrice: 470 },
          })
        ).status === 200,
        'PATCH',
      );
      await until(
        () => sheetBarrier.held.length >= 1,
        'relecture de la fiche retenue',
      );
      // Corbeille : relecture retenue (contenu : produit dans la corbeille).
      const trashBarrier = await holdResponses(
        trash.page,
        (url) => new URL(url).pathname === '/trash',
      );
      ok(
        (
          await L.http('DELETE', `/products/${p.productId}`, {
            token: ownerA.token,
          })
        ).status === 200,
        'corbeille',
      );
      await until(
        () => trashBarrier.held.length >= 1,
        'relecture de la corbeille retenue',
      );
      ok(
        (
          await L.http('DELETE', `/products/${p.productId}/permanent`, {
            token: tAdmin,
          })
        ).status === 200,
        'purge',
      );
      await sheet.page
        .getByText('Ce produit a été supprimé définitivement.')
        .waitFor({ timeout: 15000 });
      await until(
        async () => (await trash.page.getByText(p.name).count()) === 0,
        'corbeille : produit retiré à la purge',
      );
      // Sentinelles : TOUTE réapparition, même transitoire, est enregistrée.
      await armReappearance(trash.page, p.name);
      await armReappearance(sheet.page, 'Stock restant');
      sheetBarrier.release();
      trashBarrier.release();
      await observeFor(1500);
      ok(
        !(await reappeared(trash.page)),
        'corbeille : le produit n’est jamais réapparu, même brièvement',
      );
      ok(
        !(await reappeared(sheet.page)),
        'fiche : le produit n’est jamais réapparu, même brièvement',
      );
      ok(
        (await trash.page.getByText(p.name).count()) === 0,
        'corbeille : le produit ne réapparaît pas',
      );
      ok(
        (await sheet.page
          .getByText('Ce produit a été supprimé définitivement.')
          .count()) === 1 && (await stockItems(sheet.page)).length === 0,
        'fiche : le produit ne réapparaît pas',
      );
      await sheetBarrier.stop();
      await trashBarrier.stop();
      return 'deux réponses retenues (fiche, corbeille) libérées après la purge : aucune réapparition';
    },
  );

  // RT13 — coupure, opérations pendant la coupure, reconnexion.
  await scenario(
    'RT13',
    'Sections et suppression définitive pendant une coupure : rattrapage',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const admin = await L.inviteMember(ownerA.token, 'admin', 'rtAdm13');
      const tAdmin = await apiLogin(admin.email);
      const tag = Date.now().toString(36);
      const parent = await apiSection(ownerA.token, `RT13 Parent ${tag}`);
      const p = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt13', 5);
      ok(
        (
          await L.http('DELETE', `/products/${p.productId}`, {
            token: ownerA.token,
          })
        ).status === 200,
        'corbeille',
      );
      const sub = await openUser(ctx.browser, 'std-parent');
      const trash = await openUser(ctx.browser, 'admin-trash');
      ctx.users.push(sub, trash);
      await loginUi(sub.page, std.email);
      await loginUi(trash.page, admin.email);
      await sub.page.goto(`${WEB}/app/catalog/${parent._id}`);
      await sub.page.getByText('Ce catalogue est vide.').waitFor();
      await trash.page.goto(`${WEB}/app/trash`);
      await trash.page.getByText(p.name).first().waitFor();
      for (const u of [sub, trash]) await markNoReload(u.page);

      await sub.context.setOffline(true);
      await trash.context.setOffline(true);
      const child = await apiSection(
        ownerA.token,
        `RT13 Enfant ${tag}`,
        parent._id,
      );
      await apiRenameSection(
        ownerA.token,
        parent._id,
        `RT13 Parent renommé ${tag}`,
      );
      ok(
        (
          await L.http('DELETE', `/products/${p.productId}/permanent`, {
            token: tAdmin,
          })
        ).status === 200,
        'purge',
      );
      await sub.context.setOffline(false);
      await trash.context.setOffline(false);
      await sub.page.getByText(child.name).first().waitFor({ timeout: 20000 });
      await sub.page
        .getByRole('heading', { name: `RT13 Parent renommé ${tag}` })
        .waitFor({ timeout: 20000 });
      await until(
        async () => (await trash.page.getByText(p.name).count()) === 0,
        'corbeille rattrapée',
        20000,
      );
      for (const u of [sub, trash])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      return 'sous-catalogue, renommage et purge survenus hors ligne rattrapés à la reconnexion';
    },
  );

  // RT14 — seconde organisation : aucune frame ni invalidation.
  await scenario(
    'RT14',
    'Seconde organisation : aucune frame de section ou de purge',
    async (ctx) => {
      const { ownerA, ownerB } = await setupOrganizations();
      const tag = Date.now().toString(36);
      const sB = await apiSection(ownerB.token, `RT14 B ${tag}`);
      const pA = await seedNamedProduct(ownerA.token, ownerA.orgId, 'rt14', 3);
      ok(
        (
          await L.http('DELETE', `/products/${pA.productId}`, {
            token: ownerA.token,
          })
        ).status === 200,
        'corbeille A',
      );
      const b = await openUser(ctx.browser, 'ownerB');
      const bTrash = await openUser(ctx.browser, 'ownerB-trash');
      ctx.users.push(b, bTrash);
      await loginUi(b.page, ownerB.email);
      await loginUi(bTrash.page, ownerB.email);
      await b.page.goto(`${WEB}/app/catalog`);
      await b.page.getByText(sB.name).first().waitFor();
      await bTrash.page.goto(`${WEB}/app/trash`);
      await bTrash.page.getByText('Aucun produit dans la corbeille.').waitFor();
      const since = Date.now();
      const sA = await apiSection(ownerA.token, `RT14 A ${tag}`);
      await apiRenameSection(ownerA.token, sA._id, `RT14 A2 ${tag}`);
      ok(
        (await L.http('DELETE', `/sections/${sA._id}`, { token: ownerA.token }))
          .status === 200,
        'corbeille section A',
      );
      ok(
        (
          await L.http('DELETE', `/products/${pA.productId}/permanent`, {
            token: ownerA.token,
          })
        ).status === 200,
        'purge A',
      );
      await observeFor(2000);
      for (const u of [b, bTrash]) {
        const frames = u.frames.filter(
          (f) =>
            f.at >= since &&
            (f.event.startsWith('section:') || f.event.startsWith('product:')),
        );
        ok(frames.length === 0, `${u.label} : ${frames.length} frame(s) de A`);
        ok(
          getsOf(u, /^\/(sections|trash)/, since).length === 0,
          `${u.label} : aucune relecture`,
        );
      }
      ok(
        (await b.page.getByText(`RT14 A`).count()) === 0,
        'B : aucune section de A',
      );
      return 'B : 0 frame section/produit, 0 relecture, aucune donnée de A';
    },
  );

  // ─── 1-15C : membres, invitations, image de marque ─────────────────────────

  // RT15 — deux administrateurs : modifications d'un membre visibles chez le
  // collègue (droits, suspension, transfert de propriété).
  await scenario(
    'RT15',
    'Membres : modifications par un administrateur visibles chez un autre',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const adm1 = await L.inviteMember(ownerA.token, 'admin', 'rtAdm15a');
      const adm2 = await L.inviteMember(ownerA.token, 'admin', 'rtAdm15b');
      const t1 = await apiLogin(adm1.email);
      const viewer = await openUser(ctx.browser, 'admin2-members');
      ctx.users.push(viewer);
      await loginUi(viewer.page, adm2.email);
      await viewer.page.goto(`${WEB}/app/organization/members`);
      const card = memberCard(viewer.page, std.email);
      await card.waitFor();
      await markNoReload(viewer.page);
      ok(
        (await card
          .getByText('Voir les coûts et résultats financiers')
          .count()) === 0,
        'pas de finances au départ',
      );

      await patchMember(t1, std.email, {
        permissions: ['products.view_financials'],
      });
      await card
        .getByText('Voir les coûts et résultats financiers')
        .waitFor({ timeout: 15000 });
      await patchMember(t1, std.email, { status: 'suspended' });
      await card.getByText('Suspendue').waitFor({ timeout: 15000 });
      // Transfert de propriété (propriétaire → administrateur 1).
      const id = await memberIdOf(ownerA.token, adm1.email);
      const tr = await L.http(
        'POST',
        `/organizations/members/${id}/transfer-ownership`,
        { token: ownerA.token },
      );
      ok(
        tr.status === 200 || tr.status === 201,
        `transfert ${tr.status} ${tr.text}`,
      );
      await memberCard(viewer.page, adm1.email)
        .getByText('Propriétaire')
        .waitFor({ timeout: 15000 });
      ok(await stillSameDocument(viewer.page), 'aucun rechargement complet');
      const frames = viewer.frames.filter((f) => f.event === 'members:changed');
      ok(frames.length >= 3, `members:changed reçus : ${frames.length}`);
      for (const f of frames)
        ok(
          emptyPayload(f),
          `members:changed non vide : ${JSON.stringify(f.payload)}`,
        );
      return `droits, suspension, transfert visibles sans rechargement ; ${frames.length} signaux vides`;
    },
  );

  // RT16 — droits retirés puis suspension du membre visé (invitations).
  await scenario(
    'RT16',
    'Membre visé : droit d’invitation retiré puis suspension en session ouverte',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      await patchMember(ownerA.token, std.email, {
        permissions: ['members.invite'],
      });
      const pending = await apiInvite(ownerA.token, 'rt16-invite', 'seller');
      const target = await openUser(ctx.browser, 'std-invitations');
      ctx.users.push(target);
      await loginUi(target.page, std.email);
      await target.page.goto(`${WEB}/app/organization/invitations`);
      await target.page.getByText(pending.email).first().waitFor();
      await markNoReload(target.page);
      const socketsBefore = target.sockets;

      await patchMember(ownerA.token, std.email, { permissions: [] });
      await target.page
        .getByText('La permission « Inviter des membres » est requise')
        .waitFor({ timeout: 15000 });
      ok(
        (await target.page.getByText(pending.email).count()) === 0,
        'e-mails d’invitation retirés',
      );
      // Socket rouvert une fois (1-15A) : un signal ultérieur arrive encore.
      await uploadBranding(ownerA.token, { name: 'RT16 Renomme' });
      await until(
        async () => (await tenantName(target.page)) === 'RT16 Renomme',
        'en-tête relu après retrait des droits',
      );
      ok(
        target.sockets - socketsBefore === 1,
        `sockets ouverts après retrait : ${target.sockets - socketsBefore}`,
      );
      const since = Date.now();
      await observeFor(500);
      ok(
        getsOf(target, /^\/organizations\/invitations$/, since).length === 0,
        'plus aucune lecture des invitations',
      );

      await patchMember(ownerA.token, std.email, { status: 'suspended' });
      await target.page
        .locator('[data-testid=access-refused]')
        .waitFor({ timeout: 15000 });
      ok(await stillSameDocument(target.page), 'aucun rechargement complet');
      return 'liste retirée sans rechargement, 1 socket rouvert, suspension → écran de refus';
    },
  );

  // RT17 — invitations : création, révocation, acceptation ; vendeur sans droit.
  await scenario(
    'RT17',
    'Invitations : création, révocation, acceptation ; vendeur sans droit',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const adm1 = await L.inviteMember(ownerA.token, 'admin', 'rtAdm17a');
      const adm2 = await L.inviteMember(ownerA.token, 'admin', 'rtAdm17b');
      const t1 = await apiLogin(adm1.email);
      const inv = await openUser(ctx.browser, 'admin2-invitations');
      const mem = await openUser(ctx.browser, 'admin2-members');
      const seller = await openUser(ctx.browser, 'std-admin-pages');
      ctx.users.push(inv, mem, seller);
      await loginUi(inv.page, adm2.email);
      await loginUi(mem.page, adm2.email);
      await loginUi(seller.page, std.email);
      await inv.page.goto(`${WEB}/app/organization/invitations`);
      await inv.page.getByText(adm1.email).first().waitFor();
      await mem.page.goto(`${WEB}/app/organization/members`);
      await memberCard(mem.page, adm1.email).waitFor();
      await seller.page.goto(`${WEB}/app/organization/members`);
      await seller.page
        .getByText('La permission « Gérer les membres » est requise')
        .waitFor();
      const sellerSince = Date.now();
      for (const u of [inv, mem]) await markNoReload(u.page);

      const a = await apiInvite(t1, 'rt17-a', 'seller');
      await inv.page.getByText(a.email).first().waitFor({ timeout: 15000 });
      await apiRevoke(t1, a.id);
      await invitationRow(inv.page, a.email)
        .getByText('Révoquée')
        .waitFor({ timeout: 15000 });
      const b = await apiInvite(t1, 'rt17-b', 'seller');
      await invitationRow(inv.page, b.email)
        .getByText('En attente')
        .waitFor({ timeout: 15000 });
      await apiAccept(b.rawToken, 'Invite RT17');
      await invitationRow(inv.page, b.email)
        .getByText('Acceptée')
        .waitFor({ timeout: 15000 });
      await memberCard(mem.page, b.email).waitFor({ timeout: 15000 });

      await seller.page.goto(`${WEB}/app/organization/invitations`);
      await seller.page
        .getByText('La permission « Inviter des membres » est requise')
        .waitFor();
      await observeFor(1000);
      ok(
        getsOf(seller, /^\/organizations\/(members|invitations)$/, sellerSince)
          .length === 0,
        'vendeur : aucune requête vers les listes protégées',
      );
      const sellerHtml = await seller.page.content();
      for (const email of [a.email, b.email, adm1.email])
        ok(!sellerHtml.includes(email), `vendeur : e-mail affiché ${email}`);
      for (const u of [inv, mem, seller])
        for (const f of u.frames.filter((x) =>
          /:changed$|organization:updated/.test(x.event),
        )) {
          ok(emptyPayload(f), `${u.label} ${f.event} non vide`);
          ok(
            !JSON.stringify(f.payload).includes('@'),
            `${u.label} : e-mail dans une frame`,
          );
        }
      for (const u of [inv, mem])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      return 'création, révocation, acceptation et nouveau membre visibles ; vendeur : 0 requête protégée, aucun e-mail ; signaux vides';
    },
  );

  // RT18 — nom et logo : shell d'un collègue actualisé, logo réellement chargé.
  await scenario(
    'RT18',
    'Image de marque : nom et logo actualisés dans le shell d’un collègue',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const colleague = await openUser(ctx.browser, 'std-shell');
      ctx.users.push(colleague);
      await loginUi(colleague.page, std.email);
      await colleague.page.goto(`${WEB}/app/catalog`);
      await colleague.page
        .locator('[data-tenant-logo=initials]')
        .first()
        .waitFor();
      await markNoReload(colleague.page);
      const socketsBefore = colleague.sockets;
      const since = Date.now();
      const storageBefore = await storageStats();

      const logo1 = await pngLogo(240, 120, '#c0392b');
      await uploadBranding(ownerA.token, { logo: logo1 });
      const first = await until(async () => {
        const s = await logoState(colleague.page);
        return s &&
          s.loaded &&
          s.naturalWidth === 240 &&
          s.naturalHeight === 120
          ? s
          : null;
      }, 'logo 1 chargé et affiché (240 × 120)');
      await uploadBranding(ownerA.token, { name: 'RT18 Nouveau nom' });
      await until(
        async () => (await tenantName(colleague.page)) === 'RT18 Nouveau nom',
        'nom actualisé',
      );
      const logo2 = await pngLogo(160, 160, '#2980b9');
      await uploadBranding(ownerA.token, { logo: logo2 });
      const second = await until(async () => {
        const s = await logoState(colleague.page);
        return s &&
          s.loaded &&
          s.naturalWidth === 160 &&
          s.naturalHeight === 160
          ? s
          : null;
      }, 'logo 2 chargé et affiché (160 × 160)');
      ok(first.src !== second.src, 'URL du logo remplacée');
      const storage = await storageStats();
      ok(
        storage.puts - storageBefore.puts === 2,
        `envois au stockage simulé : ${storage.puts - storageBefore.puts}`,
      );
      ok(
        storage.gets > storageBefore.gets,
        'logo servi par le stockage simulé',
      );
      ok(
        !storage.keys.includes(first.src.split('/recipe-fictitious/')[1]),
        'ancien logo supprimé du stockage',
      );

      const del = await L.http('DELETE', '/organizations/current/logo', {
        token: ownerA.token,
      });
      ok(del.status === 200, `suppression du logo ${del.status}`);
      await colleague.page
        .locator('[data-tenant-logo=initials]')
        .first()
        .waitFor({ timeout: 15000 });

      // Ni nouvelle session, ni relecture du contexte, ni nouveau socket.
      ok(
        colleague.sockets === socketsBefore,
        `sockets ouverts : ${colleague.sockets - socketsBefore}`,
      );
      ok(
        getsOf(colleague, /^\/auth\/context$/, since).length === 0,
        'aucune relecture de /auth/context',
      );
      ok(
        getsOf(colleague, /^\/organizations\/current$/, since).length >= 3,
        'organisation relue',
      );
      ok(await stillSameDocument(colleague.page), 'aucun rechargement complet');
      return 'logo 240×120 puis 160×160 chargés, nom, retrait du logo ; 0 socket ni relecture de contexte en plus';
    },
  );

  // RT19 — coupure réseau, modifications, reconnexion.
  await scenario(
    'RT19',
    'Organisation : modifications pendant une coupure, rattrapage',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const adm = await L.inviteMember(ownerA.token, 'admin', 'rtAdm19');
      const shell = await openUser(ctx.browser, 'std-shell');
      const inv = await openUser(ctx.browser, 'admin-invitations');
      ctx.users.push(shell, inv);
      await loginUi(shell.page, std.email);
      await loginUi(inv.page, adm.email);
      await shell.page.goto(`${WEB}/app/catalog`);
      await shell.page.locator('[data-tenant-logo=initials]').first().waitFor();
      await inv.page.goto(`${WEB}/app/organization/invitations`);
      await inv.page.getByText(adm.email).first().waitFor();
      for (const u of [shell, inv]) await markNoReload(u.page);

      await shell.context.setOffline(true);
      await inv.context.setOffline(true);
      await uploadBranding(ownerA.token, {
        name: 'RT19 Hors ligne',
        logo: await pngLogo(200, 100, '#27ae60'),
      });
      const c = await apiInvite(ownerA.token, 'rt19-c', 'seller');
      await shell.context.setOffline(false);
      await inv.context.setOffline(false);
      await until(
        async () => (await tenantName(shell.page)) === 'RT19 Hors ligne',
        'nom rattrapé',
        20000,
      );
      await until(
        async () => {
          const s = await logoState(shell.page);
          return (
            s && s.loaded && s.naturalWidth === 200 && s.naturalHeight === 100
          );
        },
        'logo rattrapé et chargé',
        20000,
      );
      await inv.page.getByText(c.email).first().waitFor({ timeout: 20000 });
      for (const u of [shell, inv])
        ok(
          await stillSameDocument(u.page),
          `${u.label} : aucun rechargement complet`,
        );
      return 'nom, logo et invitation survenus hors ligne rattrapés à la reconnexion';
    },
  );

  // RT20 — seconde organisation ; changement de session avec réponse retenue.
  await scenario(
    'RT20',
    'Seconde organisation et changement de session : aucune contamination',
    async (ctx) => {
      const { ownerA, std, ownerB } = await setupOrganizations();
      const b = await openUser(ctx.browser, 'ownerB');
      ctx.users.push(b);
      await loginUi(b.page, ownerB.email);
      await b.page.goto(`${WEB}/app/organization/invitations`);
      await b.page
        .getByText('Aucune invitation', { exact: false })
        .first()
        .waitFor()
        .catch(() => undefined);
      const bName = await tenantName(b.page);
      // Socket de B connecté et page au repos : le rattrapage normal (1-15A,
      // lecture commencée avant la connexion) ne tombe pas dans la fenêtre.
      await until(() => b.sockets >= 1, 'socket de B ouvert');
      await waitQuiet(b, 1500);
      const since = Date.now();
      await uploadBranding(ownerA.token, { name: 'RT20 A renomme' });
      await apiInvite(ownerA.token, 'rt20-a', 'seller');
      await patchMember(ownerA.token, std.email, {
        permissions: ['products.view_financials'],
      });
      await observeFor(2000);
      const leaked = b.frames.filter(
        (f) =>
          f.at >= since &&
          /^(members|invitations):changed$|^organization:updated$/.test(
            f.event,
          ),
      );
      ok(leaked.length === 0, `B : ${leaked.length} signal(aux) de A`);
      const bReads = getsOf(
        b,
        /^\/organizations\/(current|invitations|members)$/,
        since,
      );
      ok(
        bReads.length === 0,
        `B : relecture(s) ${bReads.map((r) => new URL(r.url).pathname).join(', ')}`,
      );
      ok((await tenantName(b.page)) === bName, 'B : nom inchangé');

      // Session A → B avec une relecture de l'organisation A retenue.
      const u = await openUser(ctx.browser, 'switcher');
      ctx.users.push(u);
      await loginUi(u.page, std.email);
      await u.page.goto(`${WEB}/app/catalog`);
      await until(
        async () => (await tenantName(u.page)) === 'RT20 A renomme',
        'nom A',
      );
      const barrier = await holdResponses(
        u.page,
        (url) => new URL(url).pathname === '/organizations/current',
      );
      await uploadBranding(ownerA.token, { name: 'RT20 A retenu' });
      await until(() => barrier.held.length >= 1, 'relecture de A retenue');
      await u.page
        .getByRole('button', { name: 'Se déconnecter' })
        .first()
        .click();
      await u.page.waitForURL(/\/auth\/login/);
      await loginUi(u.page, ownerB.email);
      await until(
        async () => (await tenantName(u.page)) === bName,
        'en-tête de B',
      );
      await armReappearance(u.page, 'RT20 A');
      barrier.release();
      await observeFor(1500);
      ok(
        !(await reappeared(u.page)),
        'le nom de A n’apparaît jamais dans la session B',
      );
      ok((await tenantName(u.page)) === bName, 'en-tête toujours B');
      await barrier.stop();
      return 'B : 0 signal ni relecture ; réponse retenue de A ignorée après passage à B';
    },
  );

  // RT21 — aucune donnée sensible dans les signaux reçus par un vendeur.
  await scenario(
    'RT21',
    'Signaux d’organisation : payloads vides pour tous les membres',
    async (ctx) => {
      const { ownerA, std } = await setupOrganizations();
      const seller = await openUser(ctx.browser, 'std-catalog');
      ctx.users.push(seller);
      await loginUi(seller.page, std.email);
      await seller.page.goto(`${WEB}/app/catalog`);
      await seller.page
        .locator('[data-tenant-logo=initials]')
        .first()
        .waitFor();
      const since = Date.now();
      const x = await apiInvite(ownerA.token, 'rt21-x', 'admin', []);
      await apiAccept(x.rawToken, 'Invite RT21');
      await uploadBranding(ownerA.token, {
        logo: await pngLogo(128, 64, '#8e44ad'),
      });
      await until(
        () =>
          seller.frames.filter(
            (f) => f.at >= since && f.event === 'organization:updated',
          ).length >= 1,
        'signal reçu',
      );
      const signals = seller.frames.filter(
        (f) =>
          f.at >= since &&
          /^(members|invitations):changed$|^organization:updated$/.test(
            f.event,
          ),
      );
      ok(signals.length >= 3, `signaux reçus : ${signals.length}`);
      for (const f of signals)
        ok(
          emptyPayload(f),
          `${f.event} non vide : ${JSON.stringify(f.payload)}`,
        );
      ok(
        getsOf(seller, /^\/organizations\/(members|invitations)$/, since)
          .length === 0,
        'vendeur : aucune lecture protégée',
      );
      return `${signals.length} signaux, tous {} ; vendeur : 0 lecture protégée`;
    },
  );

  fs.writeFileSync(
    path.join(L.outputDir(), 'realtime-results.json'),
    JSON.stringify(results, null, 2),
  );
  const failed = results.filter((r) => r.status !== 'PASS').length;
  console.log(`\n${results.length - failed}/${results.length} PASS`);
  await L.close();
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  async (e) => {
    console.error(e);
    await L.close();
    process.exit(2);
  },
);
