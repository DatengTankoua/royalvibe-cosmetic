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
// cache. Toute autre page (dont /app/* et /auth/invitations/accept, exclue
// explicitement plus bas) n'est jamais interceptée : la requête part au
// réseau natif, sans lecture ni écriture de cache.
const PUBLIC_NAVIGATIONS = new Set(["/", OFFLINE_URL, "/auth/login", "/auth/register"]);

// Correction sécurité : le lien d'acceptation d'invitation porte le token
// en query string (?token=...) — jamais de cache/precache/fallback pour ce
// chemin, quel que soit le mode de requête, vérifié AVANT toute autre
// stratégie.
function isInvitationAcceptPath(pathname) {
  return pathname.startsWith("/auth/invitations/accept");
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
const SENSITIVE_URL_PATTERN = /token|access_token|code|invitation/i;
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
