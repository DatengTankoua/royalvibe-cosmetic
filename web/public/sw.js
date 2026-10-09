// Service worker Stock Master (1-11A/1-11B) — precache minimal + deny-by-
// default : seules les routes publiques listées, l'unique document d'app
// shell générique (/app/catalog) et les assets statiques versionnés
// bénéficient d'une stratégie de cache. Voir
// docs/architecture/phase-1-11b-offline-catalog.md pour le détail exact.
const CACHE_VERSION = "v3";
const CACHE_NAME = `stockmaster-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";
// Document statique générique (aucune donnée personnalisée : page
// entièrement "use client", zéro fetch serveur) — seul point d'entrée
// hors ligne pour le catalogue après une visite en ligne. Les chunks
// /_next/static/* qu'il référence doivent déjà avoir été mis en cache par
// cette visite (cache-first ci-dessous) : un premier accès JAMAIS visité
// en ligne reste impossible (aucun SW installé, aucun chunk en cache).
const APP_SHELL_URL = "/app/catalog";

// Chemins stables (sans hash de build) uniquement : les chunks
// /_next/static/* sont mis en cache à la volée (cache-first) lors de leur
// premier fetch, jamais précachés ici (nom hashé inconnu avant build, et
// aucun outil de build-time caching n'est ajouté dans cette phase).
const PRECACHE_URLS = [
  "/",
  OFFLINE_URL,
  APP_SHELL_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/brand/stock-master-logo-horizontal.png",
  "/brand/stock-master-icon.png",
];

// Seules ces navigations publiques ont un fallback offline / sont mises en
// cache. Toute autre page (dont /app/*, /auth/invitations/accept et
// /auth/verify-email et /auth/reset-password, exclues explicitement plus bas) n'est jamais interceptée : la requête part au
// réseau natif, sans lecture ni écriture de cache.
const PUBLIC_NAVIGATIONS = new Set(["/", OFFLINE_URL, "/auth/login", "/auth/register"]);

// Correction sécurité : le lien d'acceptation d'invitation porte le token
// en query string (?token=...) — jamais de cache/precache/fallback pour ce
// chemin, quel que soit le mode de requête, vérifié AVANT toute autre
// stratégie.
// 1-18B : tout le parcours d'invitation, dont la page de création de compte
// (lien envoyé à l'adresse invitée, ?token=...).
function isInvitationAcceptPath(pathname) {
  return pathname.startsWith("/auth/invitations/");
}

// 1-13A : même règle pour le lien de vérification d'email (?token=...) —
// jamais de cache, precache ni fallback, quel que soit le mode de requête.
function isEmailVerificationPath(pathname) {
  return pathname.startsWith("/auth/verify-email");
}

// 1-13B : même règle pour le lien de réinitialisation du mot de passe.
function isPasswordResetPath(pathname) {
  return pathname.startsWith("/auth/reset-password");
}

// Jamais caché : API, Socket.IO, pages/données organisationnelles (/app),
// et par construction (origin check ci-dessous) toute image privée S3
// servie sur un autre host.
function isAppOrApiPath(pathname) {
  return (
    pathname.startsWith("/app") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/socket.io")
  );
}

function isVersionedAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/brand/")
  );
}

// Filet de sécurité supplémentaire (défense en profondeur) : même hors de
// /auth/invitations/accept, jamais de cache.put pour une URL dont le
// chemin ou la query contient un identifiant sensible d'invitation/session.
const SENSITIVE_URL_PATTERN = /token|access_token|code|invitation|verify-email|reset-password/i;
function isSensitiveUrl(url) {
  return SENSITIVE_URL_PATTERN.test(url.pathname) || SENSITIVE_URL_PATTERN.test(url.search);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Purge limitée au namespace stockmaster-* : jamais un cache d'un
        // autre namespace/application partageant la même origine.
        Promise.all(
          keys
            .filter((key) => key.startsWith("stockmaster-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // jamais POST/PATCH/DELETE
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // jamais cross-origin
  if (isInvitationAcceptPath(url.pathname)) return; // token en query : jamais de cache, réseau natif
  if (isEmailVerificationPath(url.pathname)) return; // 1-13A : idem (lien de vérification)
  if (isPasswordResetPath(url.pathname)) return; // 1-13B : idem (lien de réinitialisation)

  // Exception UNIQUE et étroite (1-11B) : uniquement la navigation exacte
  // vers /app/catalog, SANS aucune query string (clé précachée invariante,
  // jamais devinable/paramétrable). Jamais de cache.put d'une réponse
  // live/personnalisée ici — seul le document précaché à l'install sert de
  // secours. Aucun autre chemin /app/* n'est concerné (exclusion normale
  // ci-dessous inchangée pour tout le reste, y compris /app/catalog/[id]
  // et /app/catalog/products/[id]).
  if (request.mode === "navigate" && url.pathname === APP_SHELL_URL && url.search === "") {
    event.respondWith(appShellFallback(request));
    return;
  }

  if (isAppOrApiPath(url.pathname)) return; // jamais /app, /api, /socket.io

  if (request.mode === "navigate") {
    if (!PUBLIC_NAVIGATIONS.has(url.pathname)) return; // page non listée : réseau natif, jamais de cache
    event.respondWith(networkFirstPublicNavigation(request));
    return;
  }

  if (isVersionedAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
  // Tout le reste : laissé au réseau natif, sans interception ni cache.
});

// Réseau d'abord ; en cas d'échec uniquement, repli vers le document générique
// précaché à l'install — jamais un cache.put ici (la réponse live n'est
// JAMAIS écrite, qu'elle réussisse ou échoue).
async function appShellFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(APP_SHELL_URL);
    return cached ?? Response.error();
  }
}

async function networkFirstPublicNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok && !isSensitiveUrl(new URL(request.url))) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached ?? (await caches.match(OFFLINE_URL));
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && !isSensitiveUrl(new URL(request.url))) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(request, response.clone());
  }
  return response;
}

// ─── Notifications Web Push (1-16A) ─────────────────────────────────────────
// Ajout au service worker EXISTANT : aucun changement de scope, de cache
// (CACHE_VERSION inchangée), de stratégie fetch ni de l'outbox des ventes.
// Ces gestionnaires n'émettent AUCUNE requête réseau : ni vente, ni
// confirmation de paiement, ni échange de session, ni passe d'outbox.
//
// Contrôle local minimal avant affichage : le message chiffré porte son
// titulaire (`aud` : utilisateur, organisation), comparé au pointeur
// d'identité hors ligne de l'appareil (`stockmaster-offline-identity`, écrit
// après chaque contexte authentifié, effacé à la déconnexion). Sans identité
// ou pour un autre compte (déconnexion hors ligne, appareil partagé), aucun
// contenu métier n'est affiché et l'abonnement du navigateur est retiré.
const PUSH_IDENTITY_DB = "stockmaster-offline-identity";
const PUSH_IDENTITY_STORE = "identity";
const PUSH_IDENTITY_KEY = "current";
const PUSH_NAVIGATE_MESSAGE = "stockmaster:push-navigate";
const PUSH_ICON = "/icons/icon-192.png";

// 1-16G — Langue de l'appareil (`stockmaster-preferences`, écrite par la
// page) pour l'unique texte propre au service worker. Les messages push
// eux-mêmes arrivent déjà dans la langue du destinataire (serveur).
// Lecture sans création, repli français.
const DEVICE_LOCALE_DB = "stockmaster-preferences";
const PUSH_DISABLED_BODY = {
  fr: "Notifications désactivées sur cet appareil.",
  en: "Notifications turned off on this device.",
};

function readDeviceLocale() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value === "en" ? "en" : "fr");
      }
    };
    setTimeout(() => done("fr"), 1000);
    let request;
    try {
      request = indexedDB.open(DEVICE_LOCALE_DB);
    } catch {
      done("fr");
      return;
    }
    request.onupgradeneeded = () => {
      request.transaction.abort();
    };
    request.onerror = () => done("fr");
    request.onblocked = () => done("fr");
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains("preferences")) {
          db.close();
          done("fr");
          return;
        }
        const get = db
          .transaction("preferences", "readonly")
          .objectStore("preferences")
          .get("locale");
        get.onsuccess = () => {
          db.close();
          done(get.result);
        };
        get.onerror = () => {
          db.close();
          done("fr");
        };
      } catch {
        db.close();
        done("fr");
      }
    };
  });
}

// Lecture SANS création : si la base n'existe pas, la mise à niveau est
// annulée (aucune base vide n'est laissée, le schéma de la page reste seul
// maître de sa création).
function readPushIdentity() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    setTimeout(() => done(null), 2000);
    let request;
    try {
      request = indexedDB.open(PUSH_IDENTITY_DB);
    } catch {
      done(null);
      return;
    }
    request.onupgradeneeded = () => {
      request.transaction.abort();
    };
    request.onerror = () => done(null);
    request.onblocked = () => done(null);
    request.onsuccess = () => {
      const db = request.result;
      try {
        if (!db.objectStoreNames.contains(PUSH_IDENTITY_STORE)) {
          db.close();
          done(null);
          return;
        }
        const get = db
          .transaction(PUSH_IDENTITY_STORE, "readonly")
          .objectStore(PUSH_IDENTITY_STORE)
          .get(PUSH_IDENTITY_KEY);
        get.onsuccess = () => {
          db.close();
          const value = get.result;
          done(
            value && typeof value.userId === "string" && typeof value.organizationId === "string"
              ? { userId: value.userId, organizationId: value.organizationId }
              : null,
          );
        };
        get.onerror = () => {
          db.close();
          done(null);
        };
      } catch {
        db.close();
        done(null);
      }
    };
  });
}

// Seuls les chemins internes de l'application sont ouverts.
function safeAppPath(url) {
  return typeof url === "string" && /^\/app(\/[A-Za-z0-9/_-]*)?$/.test(url) && !url.includes("//")
    ? url
    : "/app";
}

function parsePushMessage(event) {
  try {
    const data = event.data ? event.data.json() : null;
    if (
      !data ||
      data.v !== 1 ||
      typeof data.title !== "string" ||
      typeof data.body !== "string" ||
      typeof data.tag !== "string" ||
      !data.aud ||
      typeof data.aud.u !== "string" ||
      typeof data.aud.o !== "string"
    ) {
      return null;
    }
    return {
      title: data.title.slice(0, 80),
      body: data.body.slice(0, 200),
      tag: data.tag.slice(0, 120),
      url: safeAppPath(data.url),
      aud: data.aud,
    };
  } catch {
    return null;
  }
}

async function handlePush(event) {
  const message = parsePushMessage(event);
  const identity = await readPushIdentity();
  if (
    !message ||
    !identity ||
    identity.userId !== message.aud.u ||
    identity.organizationId !== message.aud.o
  ) {
    try {
      const subscription = await self.registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    } catch {
      // Désabonnement best effort : le serveur désactivera l'endpoint (404/410).
    }
    // Les navigateurs exigent un affichage pour chaque message reçu : texte
    // neutre, sans aucune donnée métier.
    const locale = await readDeviceLocale();
    return self.registration.showNotification("Stock Master", {
      body: PUSH_DISABLED_BODY[locale],
      tag: "stockmaster-push-disabled",
      icon: PUSH_ICON,
      data: { url: "/app" },
    });
  }
  return self.registration.showNotification(message.title, {
    body: message.body,
    tag: message.tag,
    icon: PUSH_ICON,
    badge: PUSH_ICON,
    data: { url: message.url },
  });
}

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function openFromNotification(url) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (existing) {
    // Navigation côté client dans la fenêtre ouverte (aucun rechargement).
    existing.postMessage({ type: PUSH_NAVIGATE_MESSAGE, url });
    try {
      // Autorisé pendant `notificationclick` ; refus éventuel sans effet sur
      // la navigation déjà demandée.
      await existing.focus();
    } catch {
      // fenêtre non focalisable
    }
    return;
  }
  return self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeAppPath(event.notification.data && event.notification.data.url);
  event.waitUntil(openFromNotification(url));
});
