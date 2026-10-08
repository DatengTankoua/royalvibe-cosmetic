# Phase 1-14D.2E.1 — Frontière de confiance Railway

Branche : `architecture/phase-1-14d2e1-railway-proxy-validation`
Base : **`f2192613235bf40183132127062de516e6674ac7`** (« fix(api): preserve
client IP through trusted nginx proxy », lot D.2E, présent sur
`origin/architecture/phase-1-14d2e-proxy-client-ip`). Au départ, l'arbre et
l'index étaient propres. Le stash `stash@{0}` (sauvegarde lint-staged) est
préservé.

Ce lot ne contient aucun commit, push ou déploiement. Il ne modifie pas la
configuration Railway, n'ajoute aucune route à l'application, ne fait aucun
appel CamPay et n'ajoute aucune dépendance. Aucun `.env` n'a été lu. Le
fournisseur de production reste `UnavailablePaymentProvider`. Aucune requête
n'a été envoyée à l'API de production.

**Verdict : NON VÉRIFIÉ.** Il n'y avait ni accès Railway (CLI, jeton,
tableau de bord) ni cible de test Railway autorisée. Le réglage actuel
(aucun proxy approuvé) est conservé, et aucune configuration n'est proposée.

---

## 1. Sources (consultées le 2026-10-03)

Aucune des trois pages n'affiche de date de mise à jour.

| Source | Ce qui est **documenté** | Ce qui **n'est pas** documenté |
|---|---|---|
| [Railway — Specs & Limits](https://docs.railway.com/networking/public-networking/specs-and-limits) | `X-Real-IP` identifie l'adresse distante du client ; `X-Forwarded-Proto` vaut toujours `https` ; `X-Forwarded-Host` porte l'hôte d'origine ; en-têtes limités à 32 Ko au total ; HTTP/1.1, HTTP/2, WebSocket | **`X-Forwarded-For`** : ni sa présence, ni son mode (ajout en fin de liste ou écrasement) ; nombre de proxys ; adresses de l'edge (fixes ou non) |
| [Railway — Private Networking](https://docs.railway.com/networking/private-networking/how-it-works) | Chaque service d'un même projet et environnement reçoit `<service>.railway.internal`. Tout trafic IPv4/IPv6 (TCP, UDP, HTTP) y est permis, par un maillage WireGuard qui **ne passe pas par l'entrée publique**. Les environnements et les projets sont isolés entre eux. Ce réseau n'existe pas pendant la construction | Adresses sources vues par le destinataire |
| [Railway — TCP Proxy](https://docs.railway.com/networking/tcp-proxy) (lien de la page précédente) | Un même service peut exposer HTTP **et** TCP publiquement | Conservation de l'adresse cliente, PROXY protocol |
| [Express — Behind Proxies](https://expressjs.com/en/guide/behind-proxies/) | `trust proxy` accepte un booléen, des adresses ou sous-réseaux, un nombre ou une fonction. Avec un **nombre** *n*, la socket est le premier saut, puis `X-Forwarded-For` est lu de droite à gauche. Avertissement : il ne doit exister **aucun chemin** vers l'application avec un nombre de sauts différent. `true` prend l'entrée la plus à gauche, ce qui permet l'usurpation si le dernier proxy ne réécrit pas l'en-tête. `req.ip`, `req.ips`, `req.protocol` et `req.hostname` dépendent de ce réglage (via `proxy-addr`) | — |

### Conséquences directes

1. **Express ne lit que `X-Forwarded-For`**, alors que Railway ne documente
   que `X-Real-IP`. S'appuyer sur `X-Real-IP` exigerait un tracker qui lit
   directement un en-tête, ce qui est **exclu** par le périmètre. La seule
   voie possible est donc `X-Forwarded-For` avec `TRUST_PROXY_HOPS=N`, et
   son comportement doit être **mesuré**, puisqu'il n'est pas garanti.
2. **aucune liste d’adresses n’est justifiable avec les preuves disponibles** : les adresses de l'edge ne
   sont pas documentées comme fixes. Une adresse observée une fois n'est pas
   une garantie. L'analyseur ne propose donc jamais d'adresse.
3. **Le réseau privé contourne l'entrée HTTP** (garantie documentée). Si
   l'environnement de production contient un autre service, celui-ci peut se
   connecter directement à l'API et lui envoyer un `X-Forwarded-For`
   arbitraire. Avec `HOPS=1`, ce `X-Forwarded-For` serait approuvé (le
   scénario « contournement » de l'auto-test le montre, § 4).
4. **Un proxy TCP** sur le service API offrirait aussi un chemin sans entrée
   HTTP, donc sans en-tête réécrit.

## 2. Topologie : observations en lecture seule

Les observations proviennent de l'API publique GitHub des déploiements
(`GET /repos/DatengTankoua/heyama-test/deployments` et `…/statuses`), en
lecture seule et sans authentification, ainsi que du dépôt.

| Élément | Observation | Statut |
|---|---|---|
| Plateforme de l'API | Environnement GitHub `lively-compassion / production`, créé par `railway-app[bot]` : **12** déploiements. Le README (§ Déploiement) l'annonce, et l'audit 1-A (**D9**) le confirme | Observé |
| Dernier déploiement Railway connu de GitHub | `68e0416` (= `origin/main`, merge PR #17), créé le 2026-08-21. Statuts : `success` le 2026-08-21, `inactive` le 2026-09-09, `success` le 2026-09-14, puis **`inactive` le 2026-10-01** | Observé |
| **Version API réellement en service** | **Indéterminée**. Le statut `inactive` du 2026-10-01 indique que ce déploiement a été remplacé, mais aucun déploiement plus récent n'est enregistré côté GitHub. Il peut s'agir d'un redéploiement manuel ou par CLI, d'une suppression ou d'un autre déclencheur. Seul le tableau de bord Railway peut trancher | Non vérifiable ici |
| Commit poussé de ce chantier | `f219261` est sur `origin/architecture/phase-1-14d2e-proxy-client-ip`, **pas** sur `main` (62 commits d'écart). Vercel n'en a fait qu'un **aperçu** (`Preview`, 2026-10-02). Railway ne déploie que `main` (README) | Observé |
| Code de `main` | `git grep` sur `origin/main -- api/src` : **aucun** `trust proxy`, `TRUST_PROXY*`, `X-Forwarded*` ni `ThrottlerModule`. Si `68e0416` est bien la version en service, la production n'a **aucune** limitation de débit par adresse, et le problème étudié ici est **latent**, sans effet actuel | Observé (code) ; hypothèse (déploiement) |
| Web | Vercel ; production = `68e0416`. N'appelle l'API que depuis le navigateur (D.2E) | Observé |
| Domaine Railway de l'API | Inconnu. Le README ne donne qu'un modèle (`https://<votre-service>.railway.app`) ; la valeur réelle se trouve dans les variables Vercel ou Railway, non lues | Non observé |
| Domaine personnalisé, CDN devant l'API | Inconnus. `api.royalvibe.tondomaine.com` n'est qu'un modèle de `docker-compose.prod.yml` | Non observé |
| Autres services dans l'environnement Railway (réseau privé) | Inconnus. MongoDB (Atlas) et le stockage (Supabase) sont **hors** Railway selon D9, ce qui suggère, **sans le prouver**, que l'API y est seule | Hypothèse |
| Proxy TCP sur le service API | Inconnu | Non observé |
| `docker-compose.prod.yml` | Ancien et secondaire (D9) ; validé séparément par D.2E (nginx, adresse fixe) | Hors périmètre |

Aucun chemin Railway n'a donc été observé.

## 3. Outillage préparé (`api/test/proxy/`)

| Fichier | Rôle |
|---|---|
| [`railway-observe.js`](../../api/test/proxy/railway-observe.js) | Fixture Express **indépendante**, sans base de données ni module métier. Elle applique `trust proxy` avec le helper **livré**, `resolveTrustProxySetting` / `applyTrustProxy` de `dist/common/trust-proxy.js`, soumis aux mêmes refus stricts que l'API (jamais `true`, ni plage, ni mot-clé). `GET /__observe` renvoie et journalise l'adresse de socket, `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto/Host/Port`, `Forwarded`, `Via`, `req.ip`, `req.ips`, le protocole et le hostname. Elle relève le **nom** des autres en-têtes, sans leur valeur, et jamais `Authorization`, `Cookie` ni `Proxy-Authorization`. `POST /__counter` tient un compteur à fenêtre fixe indexé sur `req.ip`, la même clé que le tracker par défaut du throttler. Toute autre route répond 404. La fixture refuse de démarrer sans `PROXY_OBSERVE_ENABLED=1`, et n'est ni incluse dans l'image (le Dockerfile ne copie que `dist/`) ni branchée sur l'application |
| [`railway-probe.js`](../../api/test/proxy/railway-probe.js) | Sonde à lancer depuis chaque client. Elle envoie sept scénarios : requête ordinaire, `X-Forwarded-For` forgé seul puis en liste, `X-Real-IP`, `Forwarded`, `X-Forwarded-Proto/Host`, tout combiné. Les adresses forgées sont des adresses de documentation (RFC 5737). L'option `--counter` ajoute une rafale avec un `X-Forwarded-For` qui change à chaque requête ; `--ip-family 4\|6` fixe la famille IP. N'accepte qu'une origine, sans chemin ni identifiants |
| [`railway-analyze.js`](../../api/test/proxy/railway-analyze.js) | Recalcule hors ligne `req.ip` pour `none` et `HOPS=1..3`, avec `proxy-addr`, la bibliothèque d'Express. Vérifie d'abord que le recalcul reproduit le `req.ip` observé, puis la couverture : deux clients aux sorties distinctes par domaine public, chemins privé, TCP et domaine personnalisé sondés ou **déclarés** absents. Vérifie enfin l'usurpation, la stabilité, la séparation des clients et le contournement des compteurs. Ne retient un réglage que si tout passe, et prend alors le plus petit nombre de sauts conforme. Sortie 0 si un réglage est justifié, 2 sinon |
| [`railway-selftest.js`](../../api/test/proxy/railway-selftest.js) | Auto-test local sur 127.0.0.1 : deux proxys d'entrée simulés (un qui ajoute en fin de liste, un qui écrase) pour deux clients, plus un accès direct qui contourne l'entrée |
| [`README.md`](../../api/test/proxy/README.md) | Mode d'emploi (section ajoutée) |

Le harnais Docker de D.2E (`run-proxy-check.js`) n'a pas été réutilisé tel
quel. Il valide nginx sur un réseau à adresses fixes, une topologie qui
n'existe pas sur Railway. Ses principes sont repris : observation des
données reçues, aucune route ajoutée à l'application, adresses sources
distinctes.

## 4. Tests effectués (locaux uniquement)

Exécutés le 2026-10-03. **Aucun de ces tests ne valide Railway.**

| Contrôle | Commande | Résultat |
|---|---|---|
| Build API (le helper lu par la fixture) | `pnpm --filter api build` | Réussi |
| Auto-test de l'outillage | `node api/test/proxy/railway-selftest.js` | **6/6** |
| Parcours CLI réel : fixture en processus séparé → sonde → analyse | `PROXY_OBSERVE_ENABLED=1 PORT=4791 node api/test/proxy/railway-observe.js`, puis `railway-probe.js … --counter`, puis `railway-analyze.js` | 7 observations. Recalcul cohérent ; `none` conforme. `HOPS=1..3` rejetés, car l'en-tête forgé est accepté sans proxy. Le compteur atteint 429 à la 6ᵉ requête, avec une seule clé. Sortie 2 : la couverture est incomplète (un seul client). `/auth/login` renvoie 404 sur la fixture |
| Garde de démarrage | `node api/test/proxy/railway-observe.js` sans la variable | Refus, sortie 1 |
| Validation des arguments | `--base https://example.com/path` ; `--ip-family 5` ; analyse sans fichier | Refus, sortie 64 |
| Tests unitaires du helper | `npx jest src/common/trust-proxy` | **43/43** |
| Syntaxe | `node --check api/test/proxy/railway-*.js` | OK |
| Format | `npx prettier --check test/proxy/railway-*.js` | OK |

Les scripts JS du harnais sont en `/* eslint-disable */`, comme ceux de
D.2E, et ESLint ne vise que `{src,test}/**/*.ts`. Aucune exécution ESLint
n'était donc pertinente.

Scénarios de l'auto-test :

1. Sans confiance, `req.ip` est la socket, les en-têtes forgés sont ignorés,
   `none` est jugé « sûr mais compteur partagé », et B hérite du compteur
   de A.
2. Entrée qui **ajoute** en fin de liste, chemin unique : `HOPS=1` est
   conforme et retenu, `HOPS=2` est rejeté (liste forgée acceptée). Le
   compteur de A garde une seule clé malgré le `X-Forwarded-For` changeant,
   A atteint 429, et le premier compte de B vaut 1 (compteurs séparés).
3. Entrée qui **écrase** l'en-tête : `HOPS=1` est retenu (`HOPS=2` est
   équivalent sur ces données).
4. Chemin **contournant** l'entrée (`--path-kind private`) : `HOPS=1` est
   rejeté (`direct/xff-single : adresse forgée acceptée`) et aucun réglage
   n'est recommandé.
5. Un seul client sur `railway-domain`, sans déclaration : le manque d'un
   second client et l'absence de sonde ou de déclaration pour les chemins
   privé, TCP et domaine personnalisé sont signalés ; aucun réglage.
6. La fixture refuse `TRUST_PROXY_HOPS=true` et `10.0.0.0/8`.

Défauts trouvés en cours de route, tous **dans le test** et corrigés sans
affaiblir l'analyse :

- les deux proxys simulés écoutaient sur des ports différents, donc
  l'analyse voyait deux hôtes distincts et non une seule entrée ; un hôte
  commun leur est désormais attribué ;
- avec une entrée qui écrase l'en-tête, plusieurs nombres de sauts sont
  équivalents ; l'analyse retient désormais le plus petit au lieu de
  refuser de conclure ;
- la garde `PROXY_OBSERVE_ENABLED` est déplacée au point d'entrée, pour que
  l'auto-test puisse importer la fixture.

## 5. Mesures manquantes

| # | Mesure | Pourquoi elle manque |
|---|---|---|
| M1 | Version API en service et inventaire réseau du service `api` (domaines Railway et personnalisés, proxy TCP, nom privé) | Aucun accès au tableau de bord ni à la CLI Railway |
| M2 | Liste des services de l'environnement `production` (chemins privés) | Idem |
| M3 | Présence d'un CDN ou proxy devant un éventuel domaine personnalisé | Domaine inconnu |
| M4 | Comportement réel de `X-Forwarded-For` à l'entrée Railway (ajout ou écrasement, nombre d'entrées, IPv4/IPv6) depuis **deux** clients aux sorties distinctes | Aucune cible de test Railway autorisée ; la production n'est pas sondée |
| M5 | En-têtes forgés, seuls et en liste, à travers l'entrée Railway | Idem |
| M6 | Chemin privé et chemin TCP vers une fixture | Idem |
| M7 | Séparation des compteurs et impossibilité de les contourner, avec le réglage candidat actif | Idem |

## 6. Conclusion

**Non vérifié.** Aucun chemin Railway n'a été mesuré, et les garanties
documentées ne couvrent pas `X-Forwarded-For`. Aucune configuration n'est
proposée. Le comportement de D.2E est **conservé** : aucun proxy approuvé
par défaut, sans `true` ni tracker lisant un en-tête.

Conséquence à connaître **avant toute fusion de D.2x dans `main`** : sur
Railway sans réglage, `req.ip` vaut l'adresse de l'edge. Tous les clients
qui passent par une même adresse d'edge **partagent** donc les compteurs
d'authentification. Aucune usurpation n'est possible, mais un seul client
peut provoquer des 429 pour les autres. Il est donc recommandé de **ne pas
déployer** la limitation d'authentification sur Railway avant d'avoir mené
la procédure du § 7, ou d'accepter explicitement ce regroupement. La
production actuelle, si elle exécute bien `68e0416`, n'est pas concernée
aujourd'hui puisqu'elle n'a aucune limitation.

## 7. Procédure opérateur reproductible

Prérequis : accès au projet Railway (rôle suffisant pour créer un service
**dans un projet de test séparé**), deux réseaux de sortie distincts (par
exemple une box et un partage 4G), Node 22 et le dépôt construit
(`pnpm --filter api build`). **Ne jamais déployer la fixture sur le service
API de production. Aucun essai de saturation sur la production.**

### 7.1 Inventaire de la production, en lecture seule (M1–M3)

Dans le tableau de bord Railway, projet `lively-compassion`, environnement
`production` :

1. Onglet **Deployments** du service `api` : noter le SHA du déploiement
   **actif**, qui est la version réellement en service.
2. Lister **tous les services** de l'environnement. Chacun peut joindre
   `api.railway.internal` sur n'importe quel port.
3. **Settings → Networking** du service `api` : domaines publics (Railway
   et personnalisés), proxy TCP (présent ou non), nom privé.
4. Pour chaque domaine personnalisé, regarder sa résolution DNS
   (`nslookup -type=CNAME <domaine>`), et chez le fournisseur DNS, si un
   proxy ou CDN est actif. Un CDN ajoute un saut.
5. Ne lire **aucune** variable secrète. Seuls `TRUST_PROXY_*` et `PORT`
   sont utiles, et leur présence suffit.

### 7.2 Cible de test isolée (M4–M7)

Créer un **projet** Railway de test, séparé, pour éviter tout réseau privé
partagé avec la production. Y reproduire la chaîne d'entrée relevée en
7.1 : même type de domaine, même CDN le cas échéant, proxy TCP seulement
s'il existe en production.

Service `observe`, depuis ce dépôt (branche de ce lot) :

- construction : `pnpm install --frozen-lockfile --filter api && pnpm --filter api build`
  (les dépendances du lockfile, sans ajout) ;
- démarrage : `node api/test/proxy/railway-observe.js` ;
- variables : `PROXY_OBSERVE_ENABLED=1`, **sans** `TRUST_PROXY_*` pour le
  premier passage ;
- générer un domaine Railway, plus un domaine personnalisé si la
  production en a un.

### 7.3 Mesures (aucune confiance active)

Sur chaque client, déterminer l'adresse de sortie dans la famille IP
utilisée (par exemple `curl -4 https://api.ipify.org`), puis lancer :

```bash
node api/test/proxy/railway-probe.js --base https://<observe>.up.railway.app \
  --label A --path-kind railway-domain --egress-ip <ip-A> --ip-family 4 \
  --counter --out probe-A-railway.json
# client B, depuis l'autre réseau, dans les 5 minutes (fenêtre du compteur) :
node api/test/proxy/railway-probe.js --base https://<observe>.up.railway.app \
  --label B --path-kind railway-domain --egress-ip <ip-B> --ip-family 4 \
  --counter --counter-requests 1 --out probe-B-railway.json
```

Répéter avec `--path-kind custom-domain` sur le domaine personnalisé, et en
IPv6 (`--ip-family 6`) si l'entrée l'accepte.

**Chemin privé**, si la production a d'autres services : dans le projet de
test, créer un second service temporaire, démarré par
`node api/test/proxy/railway-probe.js --base http://observe.railway.internal:<PORT> --label P --path-kind private`.
Recopier le JSON affiché dans ses journaux vers `probe-P-private.json`.

**Chemin TCP**, si la production en a un : activer le proxy TCP sur
`observe` et lancer `--base http://<tcp-domaine>:<port> --path-kind tcp`.

### 7.4 Analyse

```bash
node api/test/proxy/railway-analyze.js probe-*.json \
  [--declare-no-private] [--declare-no-tcp] [--declare-no-custom-domain]
```

Un drapeau `--declare-no-*` n'est permis que si l'inventaire 7.1 **prouve**
l'absence du chemin correspondant en production. Le joindre au rapport.

### 7.5 Confirmation des compteurs avec le réglage candidat

Si l'analyse renvoie `TRUST_PROXY_HOPS=N` (sortie 0) :

1. Fixer `TRUST_PROXY_HOPS=N` sur le service **de test** `observe`, puis le
   redéployer.
2. Relancer 7.3 pour A et B avec `--counter`, puis 7.4. Attendus : pour A,
   une clé unique et un 429 malgré le `X-Forwarded-For` changeant ; pour B,
   un premier compte de 1. Le recalcul doit être cohérent avec le `req.ip`
   observé.
3. Rejouer deux à trois fois sur des jours différents. L'edge peut changer
   d'instance, et un comportement observé une fois ne vaut pas garantie.

### 7.6 Décision et nettoyage

- Pour proposer `TRUST_PROXY_HOPS=N` en production, **dans un lot
  distinct**, toutes ces conditions doivent être réunies : l'analyse
  renvoie 0, la chaîne de test est identique à l'inventaire de production,
  il n'y a ni chemin privé ni chemin TCP en production (ou ils ont été
  sondés et rejetés), et les résultats sont reproductibles.
- Si un autre service de l'environnement de production peut joindre l'API,
  aucun nombre de sauts n'est sûr (§ 1, point 3). Il faut alors conserver
  le défaut, ou isoler ces services dans un autre environnement avant de
  revalider.
- Supprimer le projet de test (fixture et sonde privée). Les fichiers
  `probe-*.json` contiennent les adresses de sortie des clients : les
  conserver hors du dépôt.

## 8. Limites

- Les tests sont locaux : ils valident l'outillage et la logique de
  décision, **pas** Railway.
- L'analyseur ne couvre pas le mode `TRUST_PROXY_ADDRESSES` (inapplicable
  sur Railway) ni les fonctions de confiance personnalisées.
- Le compteur de la fixture imite la clé du throttler (`req.ip`), pas sa
  normalisation IPv6 par préfixe ; la limitation réelle reste celle de
  `@nestjs/throttler`.
- Le fonctionnement de la sonde privée par service temporaire n'a pas été
  essayé sur Railway.
- La limitation reste en mémoire et par instance, ce qui exclut la
  réplication horizontale (limite connue depuis 0B.6).

## 9. Fichiers

| Fichier | Nature |
|---|---|
| `api/test/proxy/railway-observe.js` | Nouveau : fixture d'observation |
| `api/test/proxy/railway-probe.js` | Nouveau : sonde |
| `api/test/proxy/railway-analyze.js` | Nouveau : analyse hors ligne |
| `api/test/proxy/railway-selftest.js` | Nouveau : auto-test local |
| `api/test/proxy/README.md` | Modifié : section « Observation Railway » |
| `docs/architecture/phase-1-14d2e1-railway-proxy-validation.md` | Nouveau : ce document |

Inchangés : `api/src/**` (dont `trust-proxy.ts` et `main.ts`), le
Dockerfile, les fichiers Compose, nginx, `package.json`, le lockfile, les
`.env` et la configuration Railway.
