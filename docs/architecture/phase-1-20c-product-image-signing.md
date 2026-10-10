# Lot 1-20C — Coût de signature des URL des photos produits

État : **implémenté, testé et mesuré localement**, non commité, sur
`perf/phase-1-20c-product-image-signing`. La branche part de l'état de
1-20B (non commité, conservé). `stash@{0}` est conservé.

Aucun commit, push, déploiement ni appel à un service réel. Hors périmètre,
inchangés : dispatcher, pagination, relectures temps réel.

## 1. Problème (1-20A)

`GET /products` signe **une URL par produit et par réponse**
(`ProductsService.toMetricsViews → imageUrlFor → S3Service.signedReadUrl`).
Avec le SDK AWS, une signature coûte ≈ 0,56 ms : c'était ≈ 46 % du CPU de
l'API sur le catalogue (profil 1-20A).

## 2. Changement

Fichiers : `api/src/s3/s3.service.ts` (modifié) et
`api/src/s3/signed-url-cache.ts` (nouveau).

`signedReadUrl` réutilise, pendant une durée bornée, l'URL déjà signée pour
le même objet.

| Règle | Valeur |
|---|---|
| Ordre | les contrôles existants s'exécutent **avant** le cache, à chaque appel : stockage courant, préfixe exact de l'organisation du demandeur, clé jamais fournie par le client |
| Clé de cache | contexte de signature (identité du stockage, bucket, endpoint de signature, région, identifiant d'accès, style d'adressage, mode de somme de contrôle, durée de validité) + clé de l'objet |
| Réutilisation | au plus **⅓ de la validité** après le *début* de la signature : 300 s pour 900 s (défaut), entre 20 s et 1 200 s selon `S3_SIGNED_URL_TTL_SECONDS`. Toute URL délivrée garde **au moins ⅔ de sa validité** (≥ 600 s par défaut), plus que les 5 min du web entre deux renouvellements d'une même image |
| Capacité | 10 000 entrées (≈ 0,6 Ko chacune), éviction de la moins récemment utilisée |
| Concurrence | une seule signature en cours par clé ; les appels simultanés l'attendent |
| Échec | `null` ou exception : rien en cache, libération, l'appel suivant signe de nouveau |
| Photo remplacée ou supprimée | une nouvelle photo a une **nouvelle clé** (`<préfixe>/<uuid>.<ext>`, jamais réécrite) donc une nouvelle URL. Une photo supprimée n'est plus référencée par aucun produit : son entrée n'est plus demandée et expire. |
| Identifiants | statiques (`S3_ACCESS_KEY` / `S3_SECRET_KEY`, lus au démarrage), sans jeton temporaire. Une rotation impose un redémarrage, qui vide le cache. |

Ce qui ne change pas :

- Authentification, organisation, permissions, projection des champs du
  produit : tout est calculé à chaque requête, et **aucune réponse métier
  n'est mise en cache**.
- Le stockage reste privé. Le contrat de l'API reste le même (même champ,
  URL signée de même forme), et le web n'est pas modifié.
- Les logos d'organisation passent par le même service et bénéficient de
  la même règle.

### Limites

- **Un cache ne révoque pas une URL déjà délivrée.** Comme avant, elle
  reste utilisable jusqu'à son expiration par quiconque la détient.
  Différence : une même URL peut être servie pendant 300 s à plusieurs
  lecteurs autorisés de l'organisation. Elle reste limitée au préfixe de
  l'organisation, puisque les contrôles d'accès précèdent toujours le
  cache.
- **Validité restante plus courte.** Une URL reçue a désormais au moins
  600 s de validité, au lieu de 900 s.
- **Cache par processus.** Il n'est pas partagé entre instances et ne
  survit pas à un redémarrage.

## 3. Tests

| Fichier | Couvre |
|---|---|
| `src/s3/signed-url-cache.spec.ts` (nouveau, 8) | réutilisation puis expiration (horloge simulée), clés distinctes, capacité bornée et ordre LRU, appels simultanés (une signature), erreur puis nouvel essai, `null` jamais en cache, fenêtre nulle, fenêtre comptée depuis le début de la signature |
| `src/s3/s3.service.spec.ts` (+ 7) | une signature pendant ⅓ de la validité, puis une nouvelle ; fenêtre proportionnelle (600 → 200 s) ; nouvelle photo, nouvelle URL ; **cache chaud : autre organisation et autre stockage toujours refusés** ; échec puis nouvel essai ; appels simultanés ; configurations distinctes non partagées |
| `src/s3/s3.service.signing.spec.ts` (+ 1) | signature **réelle** du SDK, horloge simulée : l'URL réutilisée en dernière seconde de fenêtre est valable ≥ 600 s, puis une nouvelle date de signature |

| Contrôle | Résultat |
|---|---|
| Unitaires `src/s3`, `src/products`, `src/organizations`, `src/storage-quota` | **437 / 437** |
| E2E `multitenant-isolation`, `organization-branding`, `product-field-permissions`, `storage-quota`, `storage-reconciliation` (accès entre organisations, photos, logos) | **126 / 126** |
| `tsc` (build), ESLint, Prettier des fichiers touchés | OK |

## 4. Mesure avant / après

### Conditions

- **Outils** : ceux de 1-20A (k6 v2.3.0, `run-campaign.js`), via
  `compare-1-20c.sh`.
- **Stack** : neuve à chaque mesure, donc cache vide au départ. Mêmes
  données déterministes, file de notifications vide, aucune autre charge.
- **Stockage** : simulé, avec le vrai calcul de signature du SDK. Aucune
  requête vers les URL signées.
- **Témoin** : état **avant 1-20C, 1-20B compris**.
  `make-baseline-dist.js --files=src/s3/s3.service.ts` copie `api/dist` et
  ne remplace que `s3/s3.service.js` par sa version de `HEAD`
  (`s3.service.ts` n'est pas modifié par 1-20B).
- **Signatures réellement calculées** : comptées par l'entrée de test, avec
  un intergiciel sur le client de signature (commandes `GetObject`). Le
  mécanisme est identique pour les deux variantes.
- **Cache froid** : palier de 15 s à 1 VU juste après le démarrage. Le
  cache n'est froid que pour la première lecture de chaque organisation.
- **Cache chaud** : paliers de 45 s, rythme de 1 itération/s/VU (4 requêtes
  par itération).
- **Mémoire libre au départ** : témoin 478 / 943 Mo, nouveau 997 / 841 Mo
  (catalogue standard / volumineux). La machine est partagée.

### Catalogue standard (profil `current`)

| Palier | Variante | it/s demandé → obtenu | `products_list` p50 / p95 ms | API cœurs | Boucle p99 méd. ms | RSS / tas Mo | Signatures calculées |
|---|---|---|---|---|---|---|---|
| froid 1 VU (15 s) | avant | 1 → 1 | 73 / 146 | 0,20 | 26 | 151 / 65 | 2 426 |
| | après | 1 → 1 | **19 / 76** | 0,12 | 25 | 146 / 66 | **153** |
| chaud 1 VU | avant | 1 → 1 | 57 / 96 | 0,13 | 25 | 154 / 71 | 7 797 |
| | après | 1 → 1 | **16 / 28** | 0,07 | 24 | 142 / 57 | **0** |
| chaud 5 VU | avant | 5 → 5 | 202 / 389 | 0,65 | 147 | 180 / 76 | 38 976 |
| | après | 5 → 5 | **54 / 91** | 0,24 | 24 | 168 / 77 | **612** |
| chaud 10 VU | avant | 10 → **8,62** | 360 / 730 | 1,26 | 395 | 192 / 101 | 72 664 |
| | après | 10 → **10** | **110 / 189** | **0,43** | **36** | 178 / 82 | **303** |

Autres routes à 10 VU :

| Route | Avant p95 | Après p95 |
|---|---|---|
| `products_by_section` | 645 ms | 146 ms |
| `product_detail` | 883 ms | 114 ms |

Requêtes : 34,5 → 40 req/s. Aucune erreur dans les deux cas. Le témoin
franchit le critère de débit de 1-20A à 10 VU (8,6 it/s, comme en 1-20A) ;
le nouveau code tient ce palier.

### Catalogue volumineux (profil `large`, 1 VU)

| Palier | Variante | `products_list` p50 / p95 / max ms | API cœurs | Boucle p99 méd. ms | Signatures |
|---|---|---|---|---|---|
| froid (15 s) | avant | 298 / 480 / 544 | 0,57 | 286 | 9 666 |
| | après | 31 / 199 / **537** | 0,19 | **25** | **603** |
| chaud (45 s) | avant | 282 / 364 / 397 | 0,53 | **277** | 28 986 |
| | après | **31 / 60 / 77** | **0,08** | **24** | **0** |

Sur le profil volumineux, le témoin franchit le critère de retard de
boucle (> 250 ms) **dès 1 VU**. Le nouveau code ne le franchit plus, à
froid comme à chaud.

**Cache froid.** La **première** lecture d'une organisation paie toujours
la signature complète : max 537 contre 544 ms pour 603 produits. Ensuite,
chaque produit est signé de nouveau au plus une fois toutes les 300 s.
Le coût est ainsi amorti sur toutes les lectures de cette fenêtre, par
tous les lecteurs autorisés de l'organisation.

Une seule comparaison par scénario : les résultats sont concordants et
aucun n'a semblé douteux.

## 5. Ce qui reste

- Le coût de la première lecture d'un gros catalogue, à froid ou au
  renouvellement toutes les 300 s, est inchangé.
- Le coût Node restant de `GET /products` (hydratation, métriques,
  sérialisation de la liste complète) relève de la pagination, hors
  périmètre.
- Les relectures du catalogue déclenchées par chaque vente (1-20A § 5.5)
  sont moins coûteuses, mais n'ont pas été remesurées : elles feront
  l'objet de leur propre lot.

## 6. Déploiement et retour arrière

- Aucune migration, aucune variable d'environnement nouvelle, aucun
  changement du web. Déployer l'API.
- `S3_SIGNED_URL_TTL_SECONDS` (inchangé) fixe aussi la fenêtre de
  réutilisation (⅓).
- À vérifier après le déploiement, sur R2 : les photos s'affichent, et une
  image restée ouverte plus de 10 min est renouvelée par le mécanisme
  existant du web.
- **Retour arrière** : redéployer l'API précédente. Aucune donnée n'est
  concernée et le cache disparaît avec le processus.

## 7. Reproduire

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=<révision avant 1-20C> --files=src/s3/s3.service.ts
for p in current large; do
  for v in baseline new; do
    K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20c.sh $p $v
  done
done
node api/test/load/compare-summary.js <dossier>
rm -rf api/.load-dist-1-20a-baseline
```

Résultats synthétiques : `docs/architecture/phase-1-20c-evidence/`
(paliers froid et chaud et conditions, par profil et par variante : 12
fichiers, 64 Ko). Les séries brutes et les synthèses k6 restent hors du
dépôt. Les preuves de 1-20A et 1-20B sont inchangées.

## 8. Fichiers

- **Application** :
  - `api/src/s3/s3.service.ts` (modifié) ;
  - `api/src/s3/signed-url-cache.ts` (nouveau).
- **Tests** :
  - `api/src/s3/signed-url-cache.spec.ts` (nouveau) ;
  - `api/src/s3/s3.service.spec.ts`, `api/src/s3/s3.service.signing.spec.ts`
    (cas ajoutés).
- **Scripts** :
  - `api/test/load/compare-1-20c.sh` (nouveau) ;
  - modifiés :
    - `make-baseline-dist.js` (option `--files`) ;
    - `load-api.js` (compteur de signatures) ;
    - `run-campaign.js` (agrégation des signatures) ;
    - `compare-summary.js` (affichage) ;
    - `README.md`.
- **Preuves** : `docs/architecture/phase-1-20c-evidence/` (nouveau).
