# Phase 0B.6 — Rate limiting sécurisé de la connexion

## Objectif
Protéger `POST /auth/login` côté **API** (frontend hors périmètre) contre les rafales et tentatives répétées. Comportements préservés : login autorisé, réponse générique `401` identifiants incorrects, fermeture de l'inscription (0B.5), WebSockets/CORS/rôles/JWT inchangés. Audit préalable : adaptateur **Express**, aucun limitateur existant, `trust proxy` absent, **1 instance** API en production → poursuite sans arrêt.

## Route protégée & limites exactes
Deux fenêtres nommées `@nestjs/throttler@6.7.0` (dépendance exacte, sans `^`), appliquées par garde **méthode** (`@UseGuards(AuthThrottlerGuard)`), jamais globales :

- `login-short` : **10 req / 60 s**, blocage **60 s**
- `login-long` : **30 req / 15 min**, blocage **15 min**

Toutes les tentatives (réussies **ou** échouées) comptent ; les helpers officiels `seconds()`/`minutes()` sont utilisés (pas de ms dispersées). `POST /auth/register` reste `403 / REGISTRATION_DISABLED` même après N appels. Aucune limitation Socket.IO dans cette phase.

## Réponse stable (limite dépassée)
HTTP **429** + `{ statusCode: 429, code: "AUTH_RATE_LIMITED", message: "Trop de tentatives de connexion. Réessayez plus tard." }` + en-tête **`Retry-After`** en secondes entières strictement positives (durée de blocage restante, `ceil(ms/1000)`). Aucune donnée révélée (email, mot de passe, tentatives restantes). Avant la limite, les réponses actuelles restent **identiques** (401 générique / 201).

## Identification du client & politique reverse proxy
Clé = IP calculée par Express (`req.ip`) via le `getTracker` par défaut du garde — **jamais** lecture manuelle de `X-Forwarded-For`. `TRUST_PROXY_HOPS` (stricte) : absente/vide/`0` → aucun proxy approuvé ; entier positif → `app.set('trust proxy', hops)` (uniquement si `> 0`) ; négatif/décimal/texte/ambigu → **erreur claire au démarrage** (aucun défaut deviné pour production). `X-Forwarded-For` falsifiée **ne contourne pas** la limite à `hops=0`. `.env.prod.example` : `# TRUST_PROXY_HOPS=0` (à **mesurer puis configurer** avant production — le déploiement ne prouve pas un hop approuvé).

## Tests
- `auth-rate-limiting.spec.ts` (unitaire, 18) : valeurs exactes des 2 fenêtres, `setHeaders:false`, corps stable `{code,message,statusCode}` sans donnée d'auth, `Retry-After` positif (et `undefined` si 0/négatif/NaN), parsing `TRUST_PROXY_HOPS` (absent/vide/0/1/`3`/négatif/décimal/texte/`1x`/hors-plage), garde 429+`Retry-After` via stub (pas d'attente réelle).
- E2E `app.e2e-spec.ts` (describe 8, 7) : login valide avant limite ; 401 générique des premières tentatives incorrectes ; N+1ᵉʳ → **429** ; corps exact `AUTH_RATE_LIMITED` ; `Retry-After` présent et positif ; `X-Forwarded-For` forgée ne réinitialise pas la limite ; inscription reste 403. Stockage du throttler **isolé** entre tests (`beforeEach` + `onApplicationShutdown` du stockage) — aucune suite n'est dépendante de l'ordre.

## Résultat RED/GREEN
**RED** : sans le garde, les 4 tests de dépassement échouent (401 au lieu de 429). **GREEN** : unités API + E2E passent.

## Limite du stockage mémoire (honnête)
Stockage **mémoire officiel** de `@nestjs/throttler` : correct pour **une seule** instance API ; compteurs **perdus au redémarrage** ; plusieurs instances ⇒ **compteurs distincts** (limitation non distribuée, non claimée). **Obligation future** : stockage partagé (Redis) obligatoire **avant** tout déploiement horizontal.
