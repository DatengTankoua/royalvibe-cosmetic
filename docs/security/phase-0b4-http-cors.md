# Phase 0B.4 — CORS HTTP fermé et configurable

## Avant / après

| Aspect | Avant | Après |
|--------|-------|-------|
| `CORS_ORIGIN` absente (prod) | `?? true` → CORS **ouvert** | `OriginConfigError` → **démarrage bloqué** |
| Origine autorisée | selon config | `Access-Control-Allow-Origin` = **écho exact** (égalité stricte) |
| Origine inconnue / `Origin` absent | `*` possible | **aucun en-tête CORS, requête passe sans 500** |
| Méthodes / en-têtes | non explicités | `GET,POST,PUT,PATCH,DELETE,OPTIONS` + `Content-Type`, `Authorization` |
| `credentials` / parsing | non piloté / `split(',')` naïf | **jamais** (Bearer) / parser 0B.3 **une seule fois** au boot |

## Variable requise
`CORS_ORIGIN` — origines http/https EXACTES, comma-separated (pas de wildcard, chemin, query, userinfo). **Obligatoire en production** : absente ou invalide → l'API ne démarre pas. Dev/test : fallback `LOCAL_DEV_ORIGINS`. `.env.prod.example` déjà conforme (inchangé).

## Tests
- `origin.helpers.spec.ts` (inchangé) : matrice du parser + `isAllowed` — pas de duplication.
- `app.e2e-spec.ts`, nouveau `describe '6. CORS HTTP strict (0B.4)'` (5 tests), middleware CORS **reproduit avant `app.init()`** comme dans `main.ts` : (1) origine autorisée → `Access-Control-Allow-Origin` exact (pas `*`) ; (2) origine inconnue → aucun header CORS, 200 pas 500 ; (3) `Origin` absent → 200 sans header ; (4) préflight `OPTIONS` → 204, 6 méthodes, `Content-Type`+`Authorization`, **pas** de credentials ; (5) `parseCORSOrigin(undefined | '   ', 'production')` → `OriginConfigError` (garde du bootstrap `main.ts`).

## Risques résiduels
1. `Origin` absent autorisé par conception (outils serveur, apps natives, health checks) : aucun header CORS émis mais la ressource reste protégée par le JWT Bearer.
2. Refus d'origine non journalisé (cohérent 0B.3) ; la garde prod est prouvée au niveau du parser E2E (le spec ne tourne pas en `NODE_ENV=production`) — `main.ts` exécute la même instruction qu'en production.

## Fichiers modifiés
- `api/src/main.ts` (M) — parser 0B.3 + delegate strict + méthodes/en-têtes, sans `credentials`.
- `api/src/events/origin.helpers.ts` (M) — + constantes `HTTP_CORS_METHODS` / `HTTP_CORS_ALLOWED_HEADERS` (frozen).
- `api/test/app.e2e-spec.ts` (M) — `CORS_ORIGIN` E2E + reproduction du middleware + `describe 6.` (5 tests).
- `docs/security/phase-0b4-http-cors.md` (N) — ce rapport.
