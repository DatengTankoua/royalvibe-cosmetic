# Harnais proxy (1-14D.2E)

Validation **réelle** de la chaîne Internet → nginx → API avec la
configuration de production du dépôt :

```bash
node api/test/proxy/run-proxy-check.js            # depuis la racine du dépôt
node api/test/proxy/run-proxy-check.js --keep-image   # garde l'image de test
```

Prérequis : Docker et Docker Compose ≥ 2.24 (`!reset` / `!override`),
`openssl`, accès au registre npm pour construire l'image (le proxy de sortie
de Docker Desktop est détecté et transmis à la seule construction).

Ce que fait le harnais :

- `docker-compose.prod.yml` (topologie réelle : réseaux `default` et `edge`,
  adresse fixe de nginx, alias `api-edge`, aucun port API publié),
  surchargé par `docker-compose.proxy-test.yml` pour l'isolement ;
- le **vrai** `nginx/nginx.conf` (certificats auto-signés de test) et la
  **vraie** image API (`api/Dockerfile`) ;
- une fixture d'observation (`observe-boot.js`) montée **uniquement ici**,
  qui enregistre `req.ip` et les en-têtes reçus dans un fichier temporaire.
  Aucune route de diagnostic n'existe dans l'application ;
- des clients conteneurisés aux adresses sources **réellement distinctes**
  (`172.31.252.10`, `.11`) et des attaquants en accès direct.

Isolement : projet `heyama_proxytest_14d2e`, aucun port publié sur l'hôte,
aucun volume nommé, environnement de test généré (jamais les vrais `.env`),
démontage systématique (`down -v --remove-orphans`), puis suppression de
l'image de test et du dossier temporaire. Résultats :
`<tmp>/heyama-proxytest-14d2e-results.json`.

---

# Observation Railway (1-14D.2E.1)

Outillage **indépendant** de l'application, pour mesurer ce que l'API reçoit
derrière l'entrée Railway, **sur un service de test isolé** (jamais sur le
service API de production). Procédure complète, critères et limites :
[`docs/architecture/phase-1-14d2e1-railway-proxy-validation.md`](../../../docs/architecture/phase-1-14d2e1-railway-proxy-validation.md).

| Fichier | Rôle |
|---|---|
| `railway-observe.js` | Fixture Express minimale (aucune base, aucun module métier). Confiance appliquée par le helper **livré** (`dist/common/trust-proxy.js`). `GET /__observe`, `POST /__counter` (compteur indexé sur `req.ip`). Refuse de démarrer sans `PROXY_OBSERVE_ENABLED=1` |
| `railway-probe.js` | Sonde : requêtes ordinaires puis forgées (`X-Forwarded-For` seul et en liste, `X-Real-IP`, `Forwarded`, `X-Forwarded-Proto/Host`), rafale de compteur avec `X-Forwarded-For` changeant. Aucun jeton, cookie ni corps métier |
| `railway-analyze.js` | Recalcule hors ligne `req.ip` pour `none`, `HOPS=1..3` avec `proxy-addr` (celui d'Express) ; vérifie couverture, usurpation, séparation des clients et compteurs. Sortie 0 = réglage justifié, 2 = aucun |
| `railway-selftest.js` | Auto-test local (127.0.0.1, proxys d'entrée simulés `append`/`overwrite`, chemin de contournement). Valide l'outillage, **pas** Railway |

```bash
pnpm --filter api build                     # le helper livré est lu dans dist/
node api/test/proxy/railway-selftest.js     # auto-test local

# Fixture (service de TEST) — depuis la racine du dépôt :
PROXY_OBSERVE_ENABLED=1 PORT=4000 node api/test/proxy/railway-observe.js

# Sonde, depuis chaque client (adresse de sortie connue) :
node api/test/proxy/railway-probe.js --base https://<fixture>.up.railway.app \
  --label A --path-kind railway-domain --egress-ip <ip-A> --ip-family 4 \
  --counter --out probe-A.json

# Analyse :
node api/test/proxy/railway-analyze.js probe-*.json [--declare-no-private] \
  [--declare-no-tcp] [--declare-no-custom-domain]
```

Variables de la fixture : `PROXY_OBSERVE_ENABLED=1` (obligatoire), `PORT`,
`TRUST_PROXY_HOPS` / `TRUST_PROXY_ADDRESSES` (mêmes règles strictes que
l'API), `OBSERVE_COUNTER_LIMIT` (5), `OBSERVE_COUNTER_WINDOW_MS` (300000).
