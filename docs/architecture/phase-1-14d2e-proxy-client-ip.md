# Phase 1-14D.2E — Proxys et identification des clients API

Branche : `architecture/phase-1-14d2e-proxy-client-ip`
Base : **`551e2c4`** (HEAD réel vérifié : « feat(api): add inactive CamPay
adapter with exact amount validation », lot 1-14D.2D commité et présent sur
`origin`). Au départ, l'arbre de travail et l'index étaient **propres** :
aucune modification non commitée de D.2D, et la modification web
préexistante (`subscription-payment-panel.tsx`) était incluse dans
`551e2c4`. Le stash `stash@{0}` est préservé.

Lot limité à la configuration des proxys et à ses validations. Il n'y a eu
aucun commit, push ni déploiement. Aucun appel CamPay, paiement ou email
réel n'a été fait. Aucun package n'a été ajouté et le lockfile n'a pas
changé. Je n'ai lu la valeur d'aucun `.env` (y compris `.env.prod`). Le
fournisseur de paiement reste indisponible. Aucun webhook ni aucune
nouvelle route n'ont été ajoutés.

Sources officielles :
[Express — behind proxies](https://expressjs.com/en/guide/behind-proxies/),
[nginx — ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

---

## 1. Topologie vérifiée

### Dans le dépôt (`docker-compose.prod.yml`, `nginx/nginx.conf`)

| Chemin vers l'API | Avant ce lot | Après |
|---|---|---|
| Internet → nginx (80/443 publiés) → `api:4000` | nginx ne transmet **ni** `X-Forwarded-For` **ni** `X-Real-IP` ; l'en-tête `X-Forwarded-For` du client passe tel quel ; `TRUST_PROXY_HOPS=0`. Résultat : `req.ip` vaut l'adresse de nginx, et **tous les clients partagent un seul compteur** | nginx reconstruit les en-têtes depuis la connexion ; l'API n'approuve **que** l'adresse fixe de nginx ; `req.ip` est l'adresse réelle du client |
| Accès direct depuis Internet au port API | Impossible : aucun port API publié | Inchangé, et vérifié |
| Accès direct depuis un autre conteneur du projet (web, minio, mongo, réseau `default`) | Possible ; avec `TRUST_PROXY_HOPS=1`, `X-Forwarded-For` aurait été **usurpable** | Possible, mais **non approuvé** : `X-Forwarded-For` ignoré, `req.ip` est l'adresse du conteneur |
| Appels internes : `HEALTHCHECK` de l'image (`fetch http://127.0.0.1:4000/health`) | `req.ip` = 127.0.0.1 | Inchangé (127.0.0.1, non approuvé) |
| WebSocket (Socket.IO) via nginx | `Upgrade` / `Connection` transmis | Conservés, et vérifiés (101) |

Le web (Next.js) ne fait aucun appel API côté serveur : `NEXT_PUBLIC_API_URL`
n'est utilisé que dans le navigateur.

La console MinIO publie le port **9001** sur l'hôte. C'est **préexistant et
hors de ce lot** ; ce port ne mène pas à l'API.

### Dépendant du déploiement réel (non vérifiable ici)

L'audit 1-A (décision **D9**) indique que la **production actuelle** est
l'API sur **Railway**, le web sur **Vercel** et MongoDB sur **Atlas**, et
que `docker-compose.prod.yml` est **ancien/secondaire**. Railway place son
**propre proxy d'entrée** devant l'API :

- les adresses de ce proxy ne sont pas connues ni fixes, donc
  `TRUST_PROXY_ADDRESSES` est inapplicable tel quel ;
- un réglage `TRUST_PROXY_HOPS=N` n'est sûr que si **tous** les chemins vers
  l'API traversent **exactement** N proxys de confiance, et si ce proxy
  **ajoute** l'adresse réelle en dernière position de `X-Forwarded-For`.
  Ce lot ne l'a **pas vérifié** (§ 6) ;
- avec le réglage actuel par défaut (aucun proxy approuvé), `req.ip` sur
  Railway vaudrait l'adresse du proxy d'entrée, et **tous les clients
  partageraient un compteur**. C'est un comportement sûr (pas
  d'usurpation) mais trop restrictif.

Aucun proxy supplémentaire (CDN, terminaison TLS extérieure) n'est décrit
dans le dépôt pour la topologie Compose.

## 2. Frontière de confiance

```
Internet ──TLS──► nginx (seule entrée publique, 80/443)
                   │  écrase X-Forwarded-For / X-Real-IP / X-Forwarded-Proto
                   │  / X-Forwarded-Host, supprime Forwarded
                   ▼  réseau `edge` (172.31.250.0/29), nginx = 172.31.250.2 (FIXE)
                  API (aucun port publié) ── trust proxy = ['172.31.250.2']
                   ▲
   réseau `default` : web, minio, mongo → connexions NON approuvées
```

- **Seule** une connexion dont l'adresse source est exactement celle de
  nginx sur `edge` peut fournir `X-Forwarded-For`. Express (proxy-addr)
  remonte la chaîne depuis la socket et s'arrête au premier saut non
  approuvé.
- nginx est l'**entrée publique directe** : il ne fait confiance à aucun
  en-tête de transfert entrant et les reconstruit depuis `$remote_addr`,
  `$scheme` et `$host`. Il n'y a donc pas de `real_ip_header` ni de
  `set_real_ip_from`.
- Si un proxy est un jour ajouté **devant** nginx (CDN, répartiteur), cette
  configuration écrasera l'adresse réelle par celle de ce proxy. Il faudra
  alors activer `ngx_http_realip_module` avec `set_real_ip_from` limité
  **aux seules adresses de ce proxy**, jamais à tous les réseaux privés,
  puis revalider (§ 6).

## 3. Modifications

### nginx (`nginx/nginx.conf`)

Dans les trois `location` (web, API, S3), **toutes** les directives
`proxy_set_header` sont regroupées. En effet, une `location` qui en définit
une n'hérite d'aucune de celles du niveau supérieur. Les en-têtes WebSocket
existants (`Upgrade`, `Connection`) et `Host` sont conservés.

```nginx
proxy_set_header   X-Forwarded-For   $remote_addr;   # jamais $proxy_add_x_forwarded_for
proxy_set_header   X-Real-IP         $remote_addr;
proxy_set_header   X-Forwarded-Proto $scheme;
proxy_set_header   X-Forwarded-Host  $host;
proxy_set_header   Forwarded         "";             # en-tête RFC 7239 du client supprimé
```

L'API est jointe via `http://api-edge:4000`. Cet alias n'existe que sur le
réseau `edge`, ce qui garantit que la source vue par l'API est l'adresse
fixe de nginx.

### Compose (`docker-compose.prod.yml`, `.env.prod.example`)

- Réseau `edge` : sous-réseau fixe `PROXY_EDGE_SUBNET` (172.31.250.0/29),
  adresse fixe de nginx `PROXY_NGINX_EDGE_ADDRESS` (172.31.250.2),
  allocation dynamique limitée à `PROXY_EDGE_DYNAMIC_RANGE`
  (172.31.250.4/30), **hors** de l'adresse de nginx.
- `api` : réseaux `default` et `edge` (alias `api-edge`),
  `TRUST_PROXY_ADDRESSES: ${PROXY_NGINX_EDGE_ADDRESS}`, **aucun port
  publié**. `TRUST_PROXY_HOPS` n'est **plus transmis** par ce compose : un
  nombre de sauts n'est pas sûr quand d'autres conteneurs peuvent joindre
  l'API directement.
- `nginx` : réseaux `default` et `edge` (adresse fixe).
- `.env.prod.example` : section réécrite, avec les trois variables non
  secrètes et les consignes associées.

### API

- [trust-proxy.ts](../../api/src/common/trust-proxy.ts) :
  `resolveTrustProxySetting(env)`, `parseTrustProxyAddresses`,
  `applyTrustProxy`. Trois modes **mutuellement exclusifs** :
  - aucun (défaut, inchangé) ;
  - `TRUST_PROXY_ADDRESSES` : liste d'adresses IP **exactes**, 8 au plus ;
  - `TRUST_PROXY_HOPS` : contrat 0B.6 inchangé.

  Sont refusés au démarrage : plage CIDR, mot-clé (`loopback`,
  `uniquelocal`…), `true`, joker, entrée vide, adresse partielle ou
  partiellement interprétable (`172.31.250.2abc`), adresse non spécifiée
  (`0.0.0.0`, `::`), doublon (casse comprise), plus de 8 adresses, et la
  combinaison des deux variables. `TRUST_PROXY_HOPS` négatif, fractionnaire,
  textuel ou au-delà de la plage sûre reste refusé (0B.6). La valeur
  `true`, c'est-à-dire la confiance globale, n'est jamais utilisée.
- [main.ts](../../api/src/main.ts) : utilise ce réglage. Sans
  configuration, `trust proxy` n'est pas réglé, comme avant.
- **Limitation de débit inchangée** : `AuthThrottlerGuard` utilise le
  tracker par défaut de `@nestjs/throttler` 6.7 (`req.ip`, normalisé). Les
  gardes de paiement et d'invitation conservent leur tracker
  utilisateur + organisation. Les limites, fenêtres, stockages, exclusions
  et réponses sont inchangés. Aucun code ne lit `X-Forwarded-For`.

## 4. Tests

| Fichier | Contenu |
|---|---|
| [trust-proxy.spec.ts](../../api/src/common/trust-proxy.spec.ts) | Analyse stricte : 7 cas valides, 20 refusés ; exclusivité des modes ; refus des sauts invalides ; jamais `true` ; aucun réglage par défaut ; copie de la liste |
| [trust-proxy.e2e-spec.ts](../../api/test/trust-proxy.e2e-spec.ts) | Vraie application Nest, `POST /auth/login` réel ; réglage appliqué par le **même code** que `main.ts`. Sans confiance, les en-têtes forgés sont ignorés, et des `X-Forwarded-For` changeants (seuls ou en liste) ne réinitialisent jamais la limite, avec le contrat 429 `AUTH_RATE_LIMITED` et `Retry-After`. Avec un proxy approuvé par adresse, `req.ip` est l'adresse transmise et les compteurs sont séparés. Une source non approuvée ne permet aucune usurpation. Les paramètres invalides sont refusés. Toutes les requêtes partent de 127.0.0.1 : ce fichier teste la **plomberie** de la confiance |
| [api/test/proxy/](../../api/test/proxy/) (harnais Docker) | Le **vrai** `docker-compose.prod.yml`, isolé par surcharge, avec le **vrai** `nginx.conf` et la **vraie** image API. Clients aux **adresses sources réellement distinctes**, attaquants en accès direct. La fixture d'observation n'est montée que dans ce harnais. Aucune route de diagnostic n'est livrée |

### Scénarios du harnais (exécution réelle)

| # | Vérification | Résultat |
|---|---|---|
| 0 | API sans port publié ; `TRUST_PROXY_ADDRESSES` = adresse fixe de nginx ; `TRUST_PROXY_HOPS` non transmis ; alias `api-edge` | ✅ |
| 1 | `nginx -t` sur le `nginx.conf` réel, dans le conteneur `nginx:alpine` | ✅ « test is successful » |
| 2 | Via nginx, la socket est `::ffff:172.31.250.2` (nginx), `req.ip` vaut **172.31.252.10** (client A), `X-Forwarded-For` reçu vaut `172.31.252.10`, `req.protocol` vaut `https`, `req.hostname` vaut l'hôte de l'API, `Forwarded` est absent | ✅ |
| 3 | `X-Forwarded-For` forgé (seul ou en liste), `X-Real-IP`, `Forwarded`, `X-Forwarded-Proto` et `X-Forwarded-Host` forgés : tous écrasés par nginx ; `req.ip` reste celle de A | ✅ |
| 4 | A est limité malgré des `X-Forwarded-For` forgés changeants : `[401×6, 429, 429]`, code `AUTH_RATE_LIMITED` | ✅ |
| 5 | B (**172.31.252.11**, autre conteneur, autre adresse source) reste autorisé (401) | ✅ |
| 6 | A en se faisant passer pour B, ou avec un nouvel `X-Forwarded-For` : toujours 429 | ✅ |
| 7a | Accès **direct** depuis le réseau `default` avec `X-Forwarded-For: <adresse de B>` : en-tête ignoré, `req.ip` est l'adresse de l'attaquant, qui a son **propre** compteur (429 au 11e essai) | ✅ |
| 7b | B n'est **pas pénalisé** par l'attaquant qui usurpait son adresse | ✅ |
| 7c | Accès direct depuis `edge` avec une adresse autre que nginx (172.31.250.3) : non approuvé | ✅ |
| 8 | WebSocket via nginx : `101` (Upgrade/Connection conservés) | ✅ |
| 8b | Contrôle : sans `Origin` autorisée, refus applicatif existant inchangé (400) | ✅ |
| 9 | Healthcheck interne : `req.ip` = 127.0.0.1 | ✅ |

### Résultats réels

Exécutés le 2026-10-02.

| Contrôle | Commande | Résultat |
|---|---|---|
| Tests unitaires ciblés | `npx jest src/common` | **98/98** (dont `trust-proxy.spec.ts`) |
| E2E ciblé | `npx jest --config ./test/jest-e2e.json test/trust-proxy.e2e-spec.ts` | **12/12** |
| Harnais proxy réel | `node api/test/proxy/run-proxy-check.js` | **13/13** (exécution finale, avec démontage) ; aucun conteneur, réseau, volume ou image de test restant |
| Configuration Compose de production | `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config --quiet` | Valide |
| Build API | `pnpm --filter api build` | Réussi |
| Unitaires API complets | `npx jest` | **67 suites, 1 268 tests verts** |
| E2E API complets | `npx jest --config ./test/jest-e2e.json --maxWorkers=1` | **21 suites, 490 tests verts** (226 s) |
| ESLint API, sans `--fix` | `npx eslint "{src,test}/**/*.ts"` | 0 erreur ; 2 avertissements **préexistants** dans des fichiers non modifiés (`test/app.e2e-spec.ts`, `test/e2e/ephemeral-mongodb.ts`) |
| Typage de production | `npx tsc --noEmit -p tsconfig.build.json` | Code 0 |

Aucun test de mutation n'a été mené, par exemple en remettant
`$proxy_add_x_forwarded_for` ou `TRUST_PROXY_HOPS=1` pour constater
l'échec. Les scénarios 3, 7a et 7c couvrent néanmoins directement ces
erreurs.

### Défauts constatés

**Configuration (corrigé, trouvé par le harnais)**

- Le réseau `edge` laissait Docker attribuer **dynamiquement**
  l'adresse réservée à nginx à l'API, démarrée avant lui. Erreur
  constatée : « Address already in use ». Ajout de
  `ip_range: 172.31.250.4/30`, qui exclut l'adresse fixe de nginx.

**Tests et harnais (corrigés, aucune assertion affaiblie)**

- Champs de `docker info` mal nommés : le proxy de construction n'était
  pas transmis.
- Comparaison d'adresse sans la forme IPv4 mappée (`::ffff:`).
- Test WebSocket sans `Origin` : il a été complété, et un contrôle
  négatif (8b) prouve que le refus provenait de la politique Socket.IO
  existante, pas de nginx.

**Incidents d'exécution**

- Depuis les conteneurs, la sortie Internet directe est **bloquée**
  (ETIMEDOUT). Docker Desktop impose son proxy `http.docker.internal:3128`.
  Le harnais transmet ce proxy à la **seule construction**, via les
  arguments prédéfinis `HTTP(S)_PROXY`, non conservés dans l'image. Le
  Dockerfile est inchangé.
- Une résolution DNS de `auth.docker.io` a échoué une fois de façon
  passagère ; elle a réussi à la tentative suivante.

## 5. Validation

- `nginx -t` : réussi (scénario 1), sur le fichier réel avec des
  certificats de test.
- `docker compose -f docker-compose.prod.yml --env-file .env.prod.example config --quiet` :
  réussi. La projection JSON inspectée ne montre aucun secret : `api` n'a
  aucun port, ses réseaux sont `default` et `edge` (alias `api-edge`), et
  `TRUST_PROXY_ADDRESSES` vaut `172.31.250.2`.
- La pile de test tourne sous le nom de projet `heyama_proxytest_14d2e`,
  sans port publié sur l'hôte, sans volume nommé, avec un environnement de
  test aléatoire. Elle est démontée en fin d'exécution. Les conteneurs de
  développement existants (`heyama-mongo`, Supabase…) n'ont pas été
  touchés.

## 6. Avant déploiement

1. **Topologie Compose** (`docker-compose.prod.yml`) :
   - vérifier que `172.31.250.0/29` n'entre pas en conflit avec un réseau
     de l'hôte, sinon adapter les trois variables ensemble ;
   - si `.env.prod` définit `TRUST_PROXY_HOPS`, la valeur est désormais
     **ignorée** par ce compose ; la supprimer pour éviter toute
     confusion ;
   - vérifier qu'aucun proxy ne se trouve devant nginx (sinon, voir § 2) ;
   - relancer `node api/test/proxy/run-proxy-check.js`.
2. **Railway (production actuelle selon D9)** — à mesurer **sur
   l'environnement réel**, avant de modifier la configuration :
   - observer depuis deux connexions d'adresses connues ce que l'API reçoit
     (`X-Forwarded-For`, adresse de la socket), avec un outil temporaire
     **hors production** ou les journaux de la plateforme ;
   - vérifier que le proxy Railway **écrase ou complète en dernière
     position** `X-Forwarded-For`, et qu'il n'existe aucun accès à l'API qui
     le contourne ;
   - seulement alors, régler `TRUST_PROXY_HOPS` au nombre mesuré. Sans
     cette preuve, garder le défaut : aucune usurpation possible, mais un
     compteur partagé.
3. Une limitation de débit répartie (Redis) reste **obligatoire** avant
   toute réplication horizontale de l'API (limite connue depuis 0B.6).

## 7. Limites restantes

- La topologie Railway n'a pas été vérifiée.
- Un proxy supplémentaire devant nginx exigerait `ngx_http_realip_module`,
  limité à ses adresses exactes.
- Le harnais nécessite Docker et l'accès au registre npm pour construire
  l'image (environ 2 à 3 minutes).
- Les adresses IPv6 de clients sont regroupées par `@nestjs/throttler`
  selon son préfixe par défaut (comportement existant, inchangé).
- La console MinIO (port 9001 publié) est hors de ce lot.

## 8. Fichiers

Modifiés :

| Fichier | Nature |
|---|---|
| `nginx/nginx.conf` | En-têtes de transfert reconstruits (web, API, S3) ; API jointe via `api-edge` |
| `docker-compose.prod.yml` | Réseau `edge` (sous-réseau, plage dynamique, adresse fixe de nginx) ; `TRUST_PROXY_ADDRESSES` ; `TRUST_PROXY_HOPS` n'est plus transmis |
| `.env.prod.example` | Section reverse proxy réécrite ; trois variables non secrètes |
| `api/src/main.ts` | Utilise `resolveTrustProxySetting` / `applyTrustProxy` |

Nouveaux :

| Fichier | Rôle |
|---|---|
| `api/src/common/trust-proxy.ts` | Analyse stricte et application de la confiance proxy |
| `api/src/common/trust-proxy.spec.ts` | Tests unitaires |
| `api/test/trust-proxy.e2e-spec.ts` | E2E sur la vraie application |
| `api/test/proxy/docker-compose.proxy-test.yml` | Surcharge d'isolement du compose de production |
| `api/test/proxy/run-proxy-check.js` | Orchestrateur du harnais |
| `api/test/proxy/observe-boot.js` | Fixture d'observation (test uniquement) |
| `api/test/proxy/client.js` | Client conteneurisé |
| `api/test/proxy/README.md` | Mode d'emploi |
| `docs/architecture/phase-1-14d2e-proxy-client-ip.md` | Ce document |

Inchangés : `api/Dockerfile`, `web/`, migrations, `package.json`, lockfile,
`.env` réels. Aucune modification préexistante n'était en attente au
départ : la modification web antérieure est incluse dans `551e2c4`.
