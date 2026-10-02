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
