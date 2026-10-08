/**
 * 1-16A — Campagne navigateur des notifications push (TEST).
 *
 * Aucun service push réel n'est contacté :
 * - côté page, `PushManager.subscribe/getSubscription` sont remplacés par un
 *   abonnement FICTIF (endpoint FCM inventé, clés générées ici) ; la
 *   permission est accordée au contexte et `Notification.requestPermission`
 *   est compté ;
 * - côté API (stack de recette), le transport push est SIMULÉ : chaque
 *   message est consigné dans `push.jsonl` (`boot-api.js`) ;
 * - la livraison au service worker EXISTANT passe par le protocole DevTools
 *   (`ServiceWorker.deliverPushMessage`), qui déclenche son vrai gestionnaire
 *   `push` avec le message consigné.
 *
 * Lancement : node api/test/recipe/recipe.js push-browser [P1..P9]
 *   --playwright=<dir> [--chromium=<exe>] [--out=<dir>]
 */
'use strict';

require('./preload.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib');

const { WEB } = L;
const PUSH_FILE = path.join(L.C.STATE_DIR, 'push.jsonl');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`délai dépassé : ${label}`);
    await sleep(200);
  }
}

function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
}

/** Messages consignés par le transport simulé de l'API. */
function pushLog() {
  if (!fs.existsSync(PUSH_FILE)) return [];
  return fs
    .readFileSync(PUSH_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Abonnement navigateur FICTIF, installé avant tout script de la page. */
function fakePushManager({ endpoint, keys }) {
  const state = (window.__push = {
    requestPermission: 0,
    subscribe: 0,
    unsubscribe: 0,
  });
  const STORE = '__recipeFakePushSubscription';
  Notification.requestPermission = async () => {
    state.requestPermission += 1;
    return 'granted';
  };
  const make = (stored) => ({
    endpoint: stored.endpoint,
    options: {
      applicationServerKey: Uint8Array.from(stored.key).buffer,
    },
    toJSON: () => ({ endpoint: stored.endpoint, keys }),
    unsubscribe: async () => {
      state.unsubscribe += 1;
      localStorage.removeItem(STORE);
      return true;
    },
  });
  PushManager.prototype.getSubscription = async function () {
    const raw = localStorage.getItem(STORE);
    return raw ? make(JSON.parse(raw)) : null;
  };
  PushManager.prototype.subscribe = async function (options) {
    state.subscribe += 1;
    const stored = {
      endpoint,
      key: Array.from(new Uint8Array(options.applicationServerKey)),
    };
    localStorage.setItem(STORE, JSON.stringify(stored));
    return make(stored);
  };
}

async function scenario(id, title, fn) {
  if (only.length && !only.includes(id)) return;
  // Limiteur de connexion en mémoire (2 connexions par scénario, même IP) :
  // remis à zéro par un redémarrage de l'API de recette.
  await L.restartApi('simulated');
  const browser = await chromium.launch({ executablePath: loaded.executable });
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  await context.grantPermissions(['notifications'], { origin: WEB });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (r) =>
    requests.push({ method: r.method(), url: r.url(), at: Date.now() }),
  );
  const started = Date.now();
  try {
    const details = await fn({ context, page, requests });
    results.push({ id, title, pass: true, details, ms: Date.now() - started });
    console.log(`✓ ${id} ${title}`);
  } catch (error) {
    const shot = path.join(L.outputDir(), `${id}-failure.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    results.push({
      id,
      title,
      pass: false,
      error: String(error && error.stack ? error.stack : error),
      ms: Date.now() - started,
    });
    console.log(`✗ ${id} ${title}\n  ${error && error.message}`);
  } finally {
    await browser.close();
  }
}

// ─── Outils communs ──────────────────────────────────────────────────────────

async function ownerWithDevice(page, label) {
  const owner = await L.registerOwner(`push-${label}`);
  const device = {
    endpoint: `https://fcm.googleapis.com/fcm/send/recette-${label}-${crypto.randomUUID()}`,
    keys: browserKeys(),
  };
  await page.addInitScript(fakePushManager, device);
  // 1-16A.1 : modal d'invitation déjà montré aujourd'hui (P1–P7 testent
  // autre chose ; P8–P9 couvrent les invitations).
  await page.addInitScript(() => {
    localStorage.setItem(
      'stockmaster.engagement.lastModalAt',
      String(Date.now()),
    );
  });
  await L.uiLogin(page, owner.email);
  await page.waitForURL(/\/app/);
  return { owner, device };
}

async function openSettings(page) {
  await page.goto(`${WEB}/app/organization/notifications`);
  await page.getByRole('heading', { name: 'Notifications' }).waitFor();
}

async function enable(page) {
  await openSettings(page);
  await page.getByRole('button', { name: 'Activer les notifications' }).click();
  await page.getByText('Me prévenir pour').waitFor();
}

async function serverDevice(device) {
  return (await L.db())
    .collection('push_subscriptions')
    .findOne({ endpoint: device.endpoint });
}

/** Identifiant d'enregistrement du service worker (DevTools). */
async function registrationId(context, page) {
  const cdp = await context.newCDPSession(page);
  const registrations = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) =>
    registrations.push(...e.registrations),
  );
  await cdp.send('ServiceWorker.enable');
  const reg = await until(
    () =>
      registrations.find(
        (r) => r.scopeURL === `${WEB}/` && !r.isDeleted,
      ),
    'enregistrement du service worker',
  );
  return { cdp, id: reg.registrationId };
}

async function deliver(context, page, payload) {
  const { cdp, id } = await registrationId(context, page);
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: WEB,
    registrationId: id,
    data: JSON.stringify(payload),
  });
}

const notifications = (page) =>
  page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.getNotifications()).map((n) => ({
      title: n.title,
      body: n.body,
      tag: n.tag,
      data: n.data,
    }));
  });

async function depleteStock(owner) {
  const { productId } = await L.seedProduct(owner.token, owner.orgId, 1);
  const sale = await L.http('POST', '/sales', {
    token: owner.token,
    body: { productId, quantity: 1, salePrice: 400 },
  });
  ok(sale.status === 201, `vente : HTTP ${sale.status}`);
  const message = await until(
    () =>
      pushLog().find(
        (m) =>
          m.payload.aud.o === owner.orgId &&
          m.payload.url === `/app/catalog/products/${productId}`,
      ),
    'message push consigné',
  );
  return { productId, message };
}

const BUSINESS = /\/sales|\/auth\/|\/payments|\/subscription-access|\/socket\.io/;

// ─── Scénarios ──────────────────────────────────────────────────────────────

async function main() {
  await scenario(
    'P1',
    'permission demandée au seul clic ; activation, préférences, état serveur',
    async ({ page }) => {
      const { owner, device } = await ownerWithDevice(page, 'p1');
      await openSettings(page);
      await page
        .getByRole('button', { name: 'Activer les notifications' })
        .waitFor();
      const before = await page.evaluate(() => ({ ...window.__push }));
      ok(
        before.requestPermission === 0 && before.subscribe === 0,
        `permission demandée sans clic : ${JSON.stringify(before)}`,
      );
      await page
        .getByRole('button', { name: 'Activer les notifications' })
        .click();
      await page.getByText('Me prévenir pour').waitFor();
      const after = await page.evaluate(() => ({ ...window.__push }));
      ok(after.requestPermission === 1, 'une demande de permission');
      ok(after.subscribe === 1, 'un abonnement navigateur');
      const record = await serverDevice(device);
      ok(record && String(record.userId) === owner.userId, 'titulaire serveur');
      ok(String(record.organizationId) === owner.orgId, 'organisation serveur');
      // 1-16A.1 : six catégories pour le propriétaire, dans la section push
      // (distincte des préférences du centre).
      const pushSection = page.locator('fieldset', {
        hasText: 'Me prévenir pour',
      });
      const labels = await pushSection.locator('label').allInnerTexts();
      ok(labels.length === 6, `six catégories (propriétaire) : ${labels}`);

      await pushSection.getByLabel(/Stock épuisé/).uncheck();
      await until(
        async () => (await serverDevice(device)).preferences.stockDepleted === false,
        'préférence enregistrée',
      );
      await page.reload();
      await page.getByText('Me prévenir pour').waitFor();
      ok(
        !(await pushSection.getByLabel(/Stock épuisé/).isChecked()),
        'préférence relue après rechargement',
      );
      ok(
        (await page.evaluate(() => window.__push.requestPermission)) === 0,
        'aucune demande au rechargement',
      );
      return { before, after, labels };
    },
  );

  await scenario(
    'P2',
    'stock épuisé : message générique livré au service worker existant, sans requête métier ni outbox',
    async ({ context, page, requests }) => {
      const { owner } = await ownerWithDevice(page, 'p2');
      await enable(page);
      const outboxBefore = await L.outboxOps(page);
      const { message } = await depleteStock(owner);
      ok(
        message.payload.body === 'Un produit est en rupture de stock.',
        'texte générique',
      );
      const mark = Date.now();
      await deliver(context, page, message.payload);
      const shown = await until(
        async () =>
          (await notifications(page)).find((n) => n.tag === message.payload.tag),
        'notification affichée',
      );
      ok(shown.title === 'Stock Master', 'titre');
      ok(shown.body === message.payload.body, 'corps');
      ok(shown.data.url === message.payload.url, 'lien interne');
      await sleep(1500);
      const business = requests.filter(
        (r) => r.at >= mark && BUSINESS.test(new URL(r.url).pathname),
      );
      ok(business.length === 0, `requêtes métier : ${JSON.stringify(business)}`);
      const outboxAfter = await L.outboxOps(page);
      ok(
        JSON.stringify(outboxAfter) === JSON.stringify(outboxBefore),
        'outbox inchangée',
      );
      return { shown, business: business.length };
    },
  );

  await scenario(
    'P3',
    'clic : route interne ouverte par navigation client (sans rechargement) ; liens externes refusés',
    async ({ context, page, requests }) => {
      await ownerWithDevice(page, 'p3');
      await page.goto(`${WEB}/app/organization/notifications`);
      await page.getByRole('heading', { name: 'Notifications' }).waitFor();
      await page.evaluate(() => {
        window.__noReload = 1;
      });
      const worker = await until(
        () => context.serviceWorkers()[0],
        'service worker',
      );
      const unsafe = await worker.evaluate(() => [
        safeAppPath('https://evil.example/app'),
        safeAppPath('//evil.example/app'),
        safeAppPath('/app/../auth/login'),
        safeAppPath(null),
        safeAppPath('/app/organization/subscription'),
      ]);
      ok(
        JSON.stringify(unsafe) ===
          JSON.stringify([
            '/app',
            '/app',
            '/app',
            '/app',
            '/app/organization/subscription',
          ]),
        `filtrage des liens : ${unsafe}`,
      );
      const mark = Date.now();
      await worker.evaluate(() => openFromNotification('/app/sales'));
      await page.waitForURL(`${WEB}/app/sales`);
      ok(
        (await page.evaluate(() => window.__noReload)) === 1,
        'navigation sans rechargement',
      );
      const posts = requests.filter(
        (r) => r.at >= mark && r.method !== 'GET' && r.method !== 'OPTIONS',
      );
      ok(posts.length === 0, `écritures après clic : ${JSON.stringify(posts)}`);
      return { unsafe };
    },
  );

  await scenario(
    'P4',
    'coexistence PWA : un seul service worker, même scope, cache stockmaster-v3 conservé',
    async ({ page }) => {
      await ownerWithDevice(page, 'p4');
      await enable(page);
      const info = await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        return {
          count: regs.length,
          scopes: regs.map((r) => r.scope),
          scripts: regs.map((r) => (r.active || r.waiting || r.installing).scriptURL),
          caches: await caches.keys(),
          precachedShell: Boolean(await caches.match('/app/catalog')),
        };
      });
      ok(info.count === 1, `enregistrements : ${info.count}`);
      ok(info.scopes[0] === `${WEB}/`, `scope ${info.scopes[0]}`);
      ok(info.scripts[0] === `${WEB}/sw.js`, `script ${info.scripts[0]}`);
      ok(info.caches.includes('stockmaster-v3'), `caches ${info.caches}`);
      ok(info.precachedShell, 'document hors ligne précaché');
      return info;
    },
  );

  await scenario(
    'P5',
    'déconnexion : appareil retiré (serveur et navigateur) ; message ultérieur sans contenu métier',
    async ({ context, page, requests }) => {
      const { owner, device } = await ownerWithDevice(page, 'p5');
      await enable(page);
      const { message } = await depleteStock(owner);
      await page.goto(`${WEB}/app`);
      await page.getByRole('button', { name: 'Se déconnecter' }).first().click();
      await page.waitForURL(/\/auth\/login/);
      const removed = requests.filter((r) =>
        r.url.endsWith('/notifications/push/subscription/remove'),
      );
      ok(removed.length === 1, `retrait serveur : ${removed.length}`);
      ok((await serverDevice(device)) === null, 'abonnement supprimé côté serveur');
      ok(
        (await page.evaluate(() =>
          localStorage.getItem('__recipeFakePushSubscription'),
        )) === null,
        'désabonnement navigateur',
      );
      await deliver(context, page, message.payload);
      const shown = await until(
        async () =>
          (await notifications(page)).find(
            (n) => n.tag === 'stockmaster-push-disabled',
          ),
        'notification neutre',
      );
      ok(
        shown.body === 'Notifications désactivées sur cet appareil.',
        'texte neutre',
      );
      const leaked = (await notifications(page)).filter(
        (n) => n.tag === message.payload.tag,
      );
      ok(leaked.length === 0, 'aucun contenu métier après déconnexion');
      return { shown };
    },
  );

  await scenario(
    'P6',
    'déconnexion hors ligne : désabonnement local, identité effacée, aucun contenu ; reprise documentée',
    async ({ context, page }) => {
      const { owner, device } = await ownerWithDevice(page, 'p6');
      await enable(page);
      const { message } = await depleteStock(owner);
      await page.goto(`${WEB}/app`);
      await page.getByRole('button', { name: 'Se déconnecter' }).first().waitFor();
      await context.setOffline(true);
      await page.getByRole('button', { name: 'Se déconnecter' }).first().click();
      await page.waitForURL(/\/auth\/login/).catch(() => {});
      ok(
        (await page.evaluate(() =>
          localStorage.getItem('__recipeFakePushSubscription'),
        )) === null,
        'désabonnement navigateur hors ligne',
      );
      // Retrait serveur impossible hors ligne : l'appareil reste actif côté
      // serveur jusqu'au premier 404/410 du service push (désactivation).
      const record = await serverDevice(device);
      ok(record && record.status === 'active', 'état serveur documenté');
      await deliver(context, page, message.payload);
      await until(
        async () =>
          (await notifications(page)).some(
            (n) => n.tag === 'stockmaster-push-disabled',
          ),
        'notification neutre',
      );
      const leaked = (await notifications(page)).filter(
        (n) => n.tag === message.payload.tag,
      );
      ok(leaked.length === 0, 'aucun contenu métier');
      await context.setOffline(false);
      return { serverStatus: record.status };
    },
  );


  // ─── 1-16A.1 : centre, cloche, invitations ────────────────────────────────

  await scenario(
    'P7',
    'centre : cloche avant le nom, compteur partagé entre deux appareils sans rechargement ni outbox, 99+, ouverture ≠ lecture',
    async ({ context, page }) => {
      const { owner } = await ownerWithDevice(page, 'p7');
      await page.goto(`${WEB}/app/notifications`);
      await page
        .getByRole('heading', { name: 'Notifications', exact: true })
        .waitFor();
      // Second appareil : autre contexte, même compte.
      const other = await context
        .browser()
        .newContext({ serviceWorkers: 'allow' });
      const phone = await other.newPage();
      const phoneRequests = [];
      phone.on('request', (r) =>
        phoneRequests.push({
          method: r.method(),
          url: r.url(),
          at: Date.now(),
        }),
      );
      await phone.addInitScript(() => {
        localStorage.setItem(
          'stockmaster.engagement.lastModalAt',
          String(Date.now()),
        );
      });
      await L.uiLogin(phone, owner.email);
      await phone.waitForURL(/\/app/);
      const bell = phone.getByTestId('notification-bell');
      await bell.waitFor();
      // Placée juste avant le nom de l'utilisateur.
      const before = await phone.evaluate(() => {
        const b = document.querySelector('[data-testid="notification-bell"]');
        const n = document.querySelector('[data-testid="user-first-name"]');
        return b && n
          ? Boolean(
              b.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING,
            )
          : null;
      });
      ok(before === true, 'cloche avant le nom');
      ok(
        (await phone.getByTestId('notification-badge').count()) === 0,
        'aucun badge initial',
      );
      const outboxBefore = await L.outboxOps(phone);

      const mark = Date.now();
      const { productId } = await L.seedProduct(owner.token, owner.orgId, 50);
      const sale = await L.http('POST', '/sales', {
        token: owner.token,
        body: { productId, quantity: 1, salePrice: 400 },
      });
      ok(sale.status === 201, `vente ${sale.status}`);
      await phone
        .getByTestId('notification-badge')
        .waitFor({ timeout: 15_000 });
      ok(
        (await phone.getByTestId('notification-badge').innerText()) === '1',
        'badge 1',
      );
      const label = await bell.getAttribute('aria-label');
      ok(/1 non lue/.test(label), `libellé accessible : ${label}`);
      // Page centre du premier appareil mise à jour sans rechargement.
      await page
        .getByText('Nouvelle vente enregistrée.')
        .waitFor({ timeout: 15_000 });

      // Ouvrir la cloche ne marque rien comme lu.
      await bell.click();
      await phone
        .getByRole('dialog', { name: 'Notifications récentes' })
        .waitFor();
      await phone.getByText('Nouvelle vente enregistrée.').waitFor();
      await phone.keyboard.press('Escape');
      await sleep(1000);
      ok(
        (await phone.getByTestId('notification-badge').innerText()) === '1',
        'toujours non lue',
      );

      // Lecture explicite sur le premier appareil → badge effacé ailleurs.
      await page.getByText('Nouvelle vente enregistrée.').click();
      await page.waitForURL(/\/app\/notifications\/[0-9a-f]{24}$/);
      await page.getByText('Montant').waitFor();
      await phone
        .getByTestId('notification-badge')
        .waitFor({ state: 'detached', timeout: 15_000 });

      const writes = phoneRequests.filter(
        (r) => r.at >= mark && r.method !== 'GET' && r.method !== 'OPTIONS',
      );
      ok(
        writes.length === 0,
        `écritures sur l'autre appareil : ${JSON.stringify(writes)}`,
      );
      ok(
        JSON.stringify(await L.outboxOps(phone)) ===
          JSON.stringify(outboxBefore),
        'outbox inchangée',
      );

      // 120 non lues → « 99+ ».
      const db = await L.db();
      const docs = Array.from({ length: 120 }, (_, i) => ({
        userId: L.oid(owner.userId),
        organizationId: L.oid(owner.orgId),
        category: 'stock-depleted',
        eventKey: `recette-p7:${owner.userId}:${i}`,
        productId: L.oid(productId),
        saleId: null,
        paymentId: null,
        reportId: null,
        coverageEndsAt: null,
        periodKind: null,
        eventAt: new Date(),
        readAt: null,
        expiresAt: null,
      }));
      await db.collection('notifications').insertMany(docs);
      await phone.reload();
      await phone.getByTestId('notification-badge').waitFor();
      ok(
        (await phone.getByTestId('notification-badge').innerText()) === '99+',
        '99+',
      );
      const label99 = await phone
        .getByTestId('notification-bell')
        .getAttribute('aria-label');
      ok(/plus de 99/.test(label99), `libellé 99+ : ${label99}`);
      // « Tout marquer comme lu » depuis le centre.
      await page.goto(`${WEB}/app/notifications`);
      await page.getByRole('button', { name: 'Tout marquer comme lu' }).click();
      await phone
        .getByTestId('notification-badge')
        .waitFor({ state: 'detached', timeout: 15_000 });
      await other.close();
      return { writes: writes.length };
    },
  );

  await scenario(
    'P8',
    'invitation push : un modal par 24 h et par appareil, accueil seulement, « Plus tard », bannière, permission au seul clic, arrêt après activation',
    async ({ context, page }) => {
      const owner = await L.registerOwner('push-p8');
      const device = {
        endpoint: `https://fcm.googleapis.com/fcm/send/recette-p8-${crypto.randomUUID()}`,
        keys: browserKeys(),
      };
      await page.addInitScript(fakePushManager, device);
      // Permission non encore décidée (le contexte n'accorde rien).
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', {
          configurable: true,
          get: () =>
            window.__push && window.__push.requestPermission > 0
              ? 'granted'
              : 'default',
        });
      });
      await L.uiLogin(page, owner.email);
      await page.waitForURL(/\/app$/);
      // Accueil après connexion et contexte chargé : premier modal.
      const modal = page.getByTestId('engagement-modal');
      await modal.waitFor({ timeout: 15_000 });
      ok(
        (await page.evaluate(() => window.__push.requestPermission)) === 0,
        'aucune demande sans clic',
      );
      await modal.getByRole('button', { name: 'Plus tard' }).click();
      await modal.waitFor({ state: 'detached' });
      ok(
        (await page.getByTestId('engagement-banner').count()) === 0,
        'bannière masquée pour la session',
      );
      await page.reload();
      await page.getByTestId('notification-bell').waitFor();
      await sleep(1500);
      ok(
        (await page.getByTestId('engagement-modal').count()) === 0,
        'pas de second modal sous 24 h',
      );

      // Écran de saisie, délai écoulé : jamais de modal hors de l'accueil,
      // bannière seulement.
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.removeItem('stockmaster.engagement.lastModalAt');
      });
      await page.goto(`${WEB}/app/sales`);
      await page
        .getByTestId('engagement-banner')
        .waitFor({ timeout: 15_000 });
      await sleep(1500);
      ok(
        (await page.getByTestId('engagement-modal').count()) === 0,
        'pas de modal hors accueil',
      );
      await page.evaluate(() =>
        localStorage.setItem(
          'stockmaster.engagement.lastModalAt',
          String(Date.now()),
        ),
      );

      // Autre onglet (nouvelle session de navigation) : bannière seulement.
      const tab = await context.newPage();
      await tab.goto(`${WEB}/app`);
      await tab.getByTestId('engagement-banner').waitFor({ timeout: 15_000 });
      await sleep(1000);
      ok(
        (await tab.getByTestId('engagement-modal').count()) === 0,
        'bannière seulement',
      );
      await tab.close();

      // 25 h plus tard : nouveau modal ; « Activer » → une demande, appareil
      // enregistré, plus aucune invitation.
      await page.evaluate(() =>
        localStorage.setItem(
          'stockmaster.engagement.lastModalAt',
          String(Date.now() - 25 * 3600 * 1000),
        ),
      );
      await page.goto(`${WEB}/app`);
      await modal.waitFor({ timeout: 15_000 });
      await modal.getByRole('button', { name: 'Activer' }).click();
      await modal.waitFor({ state: 'detached' });
      ok(
        (await page.evaluate(() => window.__push.requestPermission)) === 1,
        'une demande au clic',
      );
      await until(
        async () => Boolean(await serverDevice(device)),
        'appareil enregistré',
      );
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.setItem('stockmaster.engagement.lastModalAt', '1');
      });
      await page.reload();
      await page.getByTestId('notification-bell').waitFor();
      await sleep(2000);
      ok(
        (await page.getByTestId('engagement-modal').count()) === 0 &&
          (await page.getByTestId('engagement-banner').count()) === 0,
        'invitations arrêtées après activation',
      );
      return {};
    },
  );

  await scenario(
    'P9',
    'permission refusée → aide sans requestPermission ; installation proposée (beforeinstallprompt) puis détectée (appinstalled)',
    async ({ context, page }) => {
      const owner = await L.registerOwner('push-p9');
      const device = {
        endpoint: `https://fcm.googleapis.com/fcm/send/recette-p9-${crypto.randomUUID()}`,
        keys: browserKeys(),
      };
      await page.addInitScript(fakePushManager, device);
      await page.addInitScript(() => {
        Object.defineProperty(Notification, 'permission', {
          configurable: true,
          get: () => 'denied',
        });
      });
      await L.uiLogin(page, owner.email);
      await page.waitForURL(/\/app/);
      const banner = page.getByTestId('engagement-banner');
      await banner.waitFor({ timeout: 15_000 });
      const text = await banner.innerText();
      ok(/Notifications bloquées/.test(text), 'aide « bloquées »');
      ok(/réglages du navigateur/.test(text), 'aide aux réglages');
      ok(
        (await banner.getByRole('button', { name: 'Activer' }).count()) === 0,
        'aucun bouton Activer',
      );
      ok(
        (await page.getByTestId('engagement-modal').count()) === 0,
        'pas de modal pour un refus',
      );
      ok(
        (await page.evaluate(() => window.__push.requestPermission)) === 0,
        'aucune requestPermission',
      );

      // Installation proposée par le navigateur (événement simulé).
      await page.evaluate(() => {
        window.__installPrompted = 0;
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = async () => {
          window.__installPrompted += 1;
        };
        event.userChoice = Promise.resolve({ outcome: 'accepted' });
        window.dispatchEvent(event);
      });
      const install = page.getByText('Installer Stock Master').first();
      await install.waitFor({ timeout: 15_000 });
      await page.getByRole('button', { name: 'Installer' }).first().click();
      await until(
        async () => (await page.evaluate(() => window.__installPrompted)) === 1,
        'invite native',
      );
      ok(
        (await page.evaluate(() =>
          localStorage.getItem('stockmaster.pwa.installed'),
        )) === '1',
        'installation mémorisée',
      );
      await install.waitFor({ state: 'detached', timeout: 15_000 });

      // `appinstalled` (contexte neuf) : invitation d'installation arrêtée.
      const fresh = await context
        .browser()
        .newContext({ serviceWorkers: 'allow' });
      const p2 = await fresh.newPage();
      await p2.addInitScript(() => {
        localStorage.setItem(
          'stockmaster.engagement.lastModalAt',
          String(Date.now()),
        );
      });
      await L.uiLogin(p2, owner.email);
      await p2.waitForURL(/\/app/);
      await p2.getByTestId('notification-bell').waitFor();
      await p2.evaluate(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        event.prompt = async () => {};
        event.userChoice = Promise.resolve({ outcome: 'dismissed' });
        window.dispatchEvent(event);
      });
      const install2 = p2.getByText('Installer Stock Master').first();
      await install2.waitFor({ timeout: 15_000 });
      await p2.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
      await install2.waitFor({ state: 'detached', timeout: 15_000 });
      await fresh.close();
      return {};
    },
  );

  const out = L.outputDir();
  fs.writeFileSync(
    path.join(out, 'push-results.json'),
    JSON.stringify(results, null, 2),
  );
  const failed = results.filter((r) => !r.pass).length;
  console.log(
    `${results.length - failed}/${results.length} scénarios réussis (${out}).`,
  );
  await L.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await L.close();
  process.exit(1);
});
