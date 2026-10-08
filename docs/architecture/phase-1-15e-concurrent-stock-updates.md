# Phase 1-15E — Correction ciblée des modifications concurrentes du stock

Branche : `architecture/phase-1-15e-concurrent-stock-updates`, créée depuis
`architecture/phase-1-15d-sale-history-after-purge` à
**`6623d4005a1e29af311513d7e129d04d06b1228a`** (« fix: preserve sale history
and analytics after product purge »), identique sur `origin`. Au départ :
arbre et index propres ; `stash@{0}` (sauvegarde lint-staged `564a998`)
présent et **non touché**.

Aucun commit, push ni déploiement. Aucune base réelle, aucun service
externe. **Aucun `.env` réel lu, déplacé ou modifié** : suites API
uniquement par `recipe.js isolated`. Aucune dépendance, lockfile inchangé.
`UnavailablePaymentProvider` et webhook désactivé : inchangés.

---

## 1. Audit limité

Périmètre : `ProductsService.update` (`PATCH /products/:id`) et les
opérations de stock partagées avec les ventes.

| Chemin                                           | Écriture du stock                                                            | Protection                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| vente (`decrementStock`)                         | `findOneAndUpdate` conditionnel `remainingQuantity ≥ q`, `$inc: −q`, session | atomique sur le document, transaction vente–stock–audit (0B.7B, `893b92d`) ; tenant (1-4C.1) |
| correction / annulation de vente (`adjustStock`) | lecture puis `save()` **dans la transaction de vente**                       | un conflit d'écriture fait rejouer la transaction depuis un état relu                        |
| **ajout de stock (`update`)**                    | lecture **hors transaction**, `+= n` en mémoire, puis `save()`               | **aucune** : `save()` écrit les valeurs **absolues** `initialQuantity` / `remainingQuantity` |

`update` ne partage aucun helper de stock avec les ventes : il modifie
directement les deux champs du document lu.

### 1.1 Historique Git

- `4393c9e` (commit initial) : l'ajout de stock existe déjà sous cette
  forme (`product.initialQuantity += …; product.remainingQuantity += …;
product.save()`).
- `13c0e31` : retrait de `newRemainingQuantity` (affectation absolue du
  restant) ; le chemin `additionalStock` est conservé tel quel.
- `893b92d` (0B.7B, « make sale stock and audit writes atomic ») : `$inc`
  conditionnel et transactions pour la **vente** ; `update` n'est pas
  modifié.
- `d7c6c7d` (1-7B) : permission `stock.adjust` sur ce chemin, sans
  changement de l'écriture.

**Conclusion** : aucune protection n'a été perdue. Le chemin de
modification n'a jamais été protégé ; il **contourne** la protection
atomique introduite pour les ventes. Aucun rapport antérieur ne mentionne
cette course (recherche dans `docs/`). Rien ne permet de dire si
l'absence de protection était un choix délibéré.

## 2. Défaut reproduit sur `6623d40`

Nouvelle suite `test/product-stock-concurrency.e2e-spec.ts` (replica set
éphémère, vraies routes). Barrière posée par espionnage de l'appel
existant `AuditService.log(stock_changed)`, situé **entre** la lecture du
produit et son enregistrement ; aucune attente à durée fixe. Le stock
contrôlé est celui **relu en base**, indépendamment de l'ajustement
comptable de 1-15D. Aucun web démarré.

`recipe.js isolated api-e2e product-stock-concurrency`, code de `6623d40`
(seuls les tests ajoutés) : **4 échecs / 7** :

| Cas                                                         | Attendu      | Obtenu sur `6623d40`                         |
| ----------------------------------------------------------- | ------------ | -------------------------------------------- |
| ajout de 5 retenu, vente de 3 intercalée (après vente de 2) | `25 / 20`    | **`25 / 23`** (vente écrasée — cas de 1-15D) |
| deux ajouts concurrents (5 et 7)                            | `32 / 32`    | **`25 / 25`** (un ajout perdu)               |
| ajout retenu, correction de vente 4 → 6 intercalée          | restant `16` | **`18`** (correction écrasée)                |
| ajout retenu, produit supprimé définitivement entre-temps   | 404          | **500** (`save()` d'un document disparu)     |

Déjà conformes : refus (section absente), produit d'une autre
organisation, corrections et annulations seules.

## 3. Correction

`ProductsService.update`, seul fichier de production modifié :

- l'ajout n'est **plus appliqué au document lu** ; il est mémorisé
  (`addedStock`) ;
- l'enregistrement est **une seule écriture atomique d'un document** :
  `findOneAndUpdate({ _id, organizationId }, { $set: <champs modifiés>,
$inc: { initialQuantity: n, remainingQuantity: n } }, { returnDocument:
'after', runValidators: true })`. `$set` = `product.getChanges()`, soit
  exactement les champs que `save()` aurait écrits (nom, prix, section,
  image ; jamais `organizationId` ni le stock) ;
- aucune modification → aucune écriture (comme `save()` sans changement) ;
- document absent à l'écriture (supprimé entre-temps) → **404**, rien
  n'est recréé, aucune émission, aucune suppression d'image ;
- réponse et `product:updated` : document **renvoyé par l'écriture**
  (vente concurrente comprise), émis après succès comme avant.

Pourquoi ce choix :

- même mécanisme que `decrementStock` (`$inc` sur le document) ; les
  `$inc` concurrents se composent, la base sérialise les écritures d'un
  même document ;
- aucune transaction ajoutée, donc **aucun callback rejouable** : aucune
  reprise applicative ne peut appliquer deux fois l'ajout. La seule
  reprise possible est celle du pilote (`retryableWrites`), dédupliquée par
  le serveur (même identifiant de transaction) ;
- une vente en cours dans sa transaction : l'écriture hors transaction
  attend sa fin ; si l'ajout passe d'abord, la transaction de vente bute
  sur un conflit et est rejouée depuis l'état relu (mécanisme existant) ;
- aucun verrou JavaScript, aucun appel S3 ou réseau dans une transaction ;
  l'ancienne image n'est supprimée qu'après l'écriture réussie (inchangé).

Inchangés : sens des champs et des opérations de stock (`additionalStock

> 0` ajoute la même quantité aux deux champs), validations préalables
(nom unique, section active du tenant), journal d'audit (mêmes traces, même
ordre), permissions (`products.manage`/`stock.adjust`), isolation,
ventes, UUID, idempotence, outbox, noms enregistrés et historique 1-15D,
`adjustStock`, `decrementStock`, purge, contrôleur, DTO, contrat de
> réponse, événements.

## 4. Preuves de concurrence

`test/product-stock-concurrency.e2e-spec.ts` (7 tests) :

| Test                                                     | Résultat après correction                         |
| -------------------------------------------------------- | ------------------------------------------------- |
| ajout retenu + vente intercalée                          | `25 / 20` ; réponse : restant 20, 5 vendus        |
| deux ajouts concurrents ayant lu le même état            | `32 / 32` : chaque ajout exactement une fois      |
| ajout retenu + correction 4 → 6, puis ajout + annulation | `25 / 16`, puis `26 / 20`                         |
| corrections et annulations seules (dont refus 400)       | inchangé : `20 / 18`, refus sans effet, `20 / 20` |
| refus (section absente) avec nom, prix et stock          | 404 ; produit intact ; aucun `product:updated`    |
| produit supprimé définitivement pendant la modification  | 404 ; rien recréé ; aucun `product:updated`       |
| produit d'une autre organisation                         | 404 ; aucune mutation                             |

Tests unitaires (`products.service.spec.ts`) : `$inc` sans valeur absolue,
document lu non modifié pour le stock ; `$set` limité aux champs modifiés,
filtre tenant ; écriture absente → 404 sans émission ni suppression
d'image ; aucune écriture sans changement ; image supprimée après
l'écriture. Les documents simulés exposent un équivalent de
`getChanges()` qui inclut le stock : une écriture absolue serait visible.

### 4.1 Compatibilité 1-15D

`test/sale-history-purge.e2e-spec.ts` :

- le test qui provoquait l'écrasement vérifie désormais un stock
  **cohérent** (`25 / 20`), une vue d'ensemble `2000 / 1500` (coût
  `100 × (25 − 20)`), un bénéfice conservé à la purge et **aucun**
  ajustement ;
- l'écart historique est désormais une **fixture explicite** (stock
  `25 / 23` écrit directement en base éphémère, comme l'ancienne écriture
  perdue) : la purge écrit l'ajustement `−3` et conserve le bénéfice.
  `purged_stock_adjustments` est conservé ; aucune donnée n'est corrigée
  automatiquement.

Les aides `barrier` / `until` de 1-15D sont déplacées dans
`test/e2e/barriers.ts` et partagées par les deux suites.

## 5. Commandes et résultats

| Commande                                                                      | Résultat                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `recipe.js isolated api-e2e product-stock-concurrency` — `6623d40`            | **4 échecs / 7** (§2)                                                                          |
| idem — corrigé                                                                | **7/7**                                                                                        |
| `recipe.js isolated api-e2e sale-history-purge product-stock-concurrency`     | 2 suites, **19/19**                                                                            |
| `recipe.js isolated api-unit products sales`                                  | 10 suites, **186/186**                                                                         |
| `recipe.js isolated api-e2e product multitenant sales`                        | 5 suites, **75/75**                                                                            |
| `recipe.js isolated api-unit` (complet, une fois)                             | **70/70 suites, 1376/1376** ; aucune tentative d'accès `.env`                                  |
| `recipe.js isolated api-e2e` (complet, une fois, après la suite unitaire)     | **26/26 suites, 582/582** ; `existsSync api\.env` bloqué 25 fois, jamais lu                    |
| `tsc --noEmit -p tsconfig.build.json`                                         | 0 erreur                                                                                       |
| Typage complet comparé à `6623d40`                                            | 238 / 238 (+1 artefact de copie côté `6623d40`) ; **aucune erreur nouvelle** (voir ci-dessous) |
| `pnpm --filter api exec eslint "{src,apps,libs,test}/**/*.ts"` (sans `--fix`) | 0 erreur, 2 avertissements préexistants                                                        |
| `prettier --check` (fichiers modifiés) ; `git diff --check`                   | OK ; OK                                                                                        |
| Lockfile                                                                      | inchangé                                                                                       |

Typage complet : même méthode qu'en 1-15C/1-15D (copie de `src`, `test` et
`tsconfig.json` de `6623d40` sous `api/`, supprimée ensuite ; messages
comparés par fichier et code). Seul écart textuel : le `TS2352`
préexistant de `subscription-access-routes.spec.ts` (70,19), identique en
position, dont le message liste les contrôleurs dans un autre ordre ; plus
l'artefact connu `subscription-pricing.spec.ts` côté copie.

Interface, contrat d'API et événements inchangés : **aucune campagne
navigateur ni build web** (non requis).

## 6. Fichiers

| Fichier                                                     | Changement                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `api/src/products/products.service.ts`                      | `update` : ajout en `$inc`, écriture atomique unique, 404 si disparu    |
| `api/src/products/products.service.spec.ts`                 | `getChanges()` simulé ; 5 tests adaptés ; +3 tests                      |
| `api/test/product-stock-concurrency.e2e-spec.ts`            | **Nouveau** : 7 tests de concurrence                                    |
| `api/test/e2e/barriers.ts`                                  | **Nouveau** : `barrier`, `until` (repris de 1-15D)                      |
| `api/test/sale-history-purge.e2e-spec.ts`                   | aides partagées ; test d'écrasement → stock cohérent ; écart en fixture |
| `docs/architecture/phase-1-15e-concurrent-stock-updates.md` | **Nouveau** : ce document                                               |

## 7. Limites

- **Données anciennes** : un stock déjà faussé par l'ancienne écriture
  perdue reste faux ; aucune correction automatique. À la purge, l'écart
  est conservé par `purged_stock_adjustments` (1-15D) pour le bénéfice
  global ; tant que le produit existe, la vue d'ensemble suit le stock
  enregistré (règle existante). Aucun moyen fiable de distinguer après
  coup un écart dû à la course d'une autre incohérence.
- **Champs descriptifs** (nom, prix, section, image) : deux modifications
  concurrentes restent « dernier écrit gagnant », comme avant (hors
  périmètre : aucun effet sur le stock).
- **Journal d'audit** : inchangé ; `stock_changed` et les autres traces
  restent écrits avant l'enregistrement (tentatives, cf. 1-15D §4.2). Un
  ajout refusé après sa trace (section absente) laisse la trace sans effet
  sur le stock.
- **Validations de schéma** : `runValidators` s'applique au `$set` ;
  l'ajout est garanti positif par le service (`additionalStock > 0`).
- **`adjustStock`** reste une lecture puis `save()` ; il n'est appelé que
  dans les transactions de vente, où un conflit rejoue la transaction
  (prouvé par le cas « correction intercalée »).
