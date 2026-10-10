# Lot 1-19A — Invitations terminées et notifications des actions des membres

État : **implémenté, testé localement et recetté dans le navigateur**
(finition comprise), non commité, sur
`feature/phase-1-19a-member-activity-notifications`. La branche part de
`origin/main` (`29bfd1a`, qui contient 1-18E fusionné). `stash@{0}` est
conservé.

Aucun commit, push ni déploiement n'a été fait. Aucun service réel n'a été
appelé : base MongoDB temporaire, e-mails, paiement et transport push
simulés.

Aucun second système de notifications n'a été créé. Tout passe par
l'existant (1-16A / 1-16A.1) : outbox `push_jobs`, dispatcher, centre
`notifications`, signal privé `notifications:changed`, Web Push.

## 1. Invitations terminées

### Parcours réels (vérifiés dans le code)

| Parcours | Avant | Après |
|---|---|---|
| Acceptation, compte existant (`POST /auth/invitations/accept`) | statut `accepted` | **supprimée** dans la transaction d'adhésion |
| Acceptation, nouveau compte (`POST /auth/invitations/create-account`) | statut `accepted` | **supprimée** dans la transaction de création |
| Révocation par un membre (`POST /organizations/invitations/:id/revoke`) | statut `revoked` | **supprimée** ; la réponse garde le contrat (vue, `status: "revoked"`) |
| « Pas maintenant » / « Annuler » sur la page d'invitation | local, aucun appel | inchangé : rien n'est envoyé, l'invitation reste |
| Mauvais compte (403), consentement absent (400), déjà membre (409), échec transactionnel (500) | invitation intacte | inchangé : rollback, invitation intacte |
| Expiration | `expired` | inchangé (hors périmètre) |

**Rejet explicite par l'invité : ce parcours n'existe pas.** Le bouton
libellé « Pas maintenant » (`invitation.decline`) n'appelle pas l'API. Aucun
rejet serveur n'a été inventé dans ce lot. S'il en faut un, il devra exiger
la même preuve d'identité que l'acceptation.

### Garanties 1-18B conservées

- La réclamation est un `findOneAndDelete` conditionnel
  (`pending`, non expirée, jeton, adresse de la session). Il s'exécute dans
  la transaction qui crée l'adhésion et la preuve légale : tout échec annule
  la suppression.
- **Usage unique et concurrence.** Deux acceptations simultanées donnent
  une seule réussite, une seule adhésion et un seul événement.
- **Rejeu.** Les deux liens (lien du créateur et lien de création de
  compte) ne désignent plus rien : `INVITATION_INVALID_OR_EXPIRED`.
- Permissions, preuve d'identité et consentement explicite : inchangés.
- **Ce qui reste prouvé ailleurs.** La membership (rôle, permissions,
  `invitedById`, `joinedAt`) et `legal_acceptances`. Aucun jeton n'est
  conservé.
- La notification « nouveau membre » ne référence que la membership et
  l'utilisateur, jamais l'invitation supprimée.

### Nettoyage historique (préparé, non exécuté)

`pnpm --filter api migrate:purge-terminated-invitations` (ou
`node dist/migrations/purge-terminated-invitations.js`) :

- sans option : **aperçu** du nombre de documents `accepted` et `revoked`,
  sans aucune écriture ;
- `--apply` : suppression de ces seuls statuts. Le traitement est
  idempotent : relancé, il supprime 0 document ;
- `pending` et `expired` ne sont jamais touchés ;
- aucune adresse, aucun identifiant ni aucune URI n'apparaît dans la
  sortie.

Il n'a été exécuté sur aucune base réelle.

## 2. Matrice action → destinataires → permission → canal → tests

Canal : **centre** = notification persistante, compteur non lu et signal
temps réel ; **push** = Web Push existant, si activé, si l'appareil y a
consenti et si sa préférence l'autorise.

| Action réussie | Destinataires (auteur toujours exclu) | Règle | Canal | Tests |
|---|---|---|---|---|
| Adhésion par invitation (2 parcours) | membres actifs avec `members.manage` (propriétaire et admin inclus par défaut) | `members.manage`, droit réel de la section Membres | centre + push | e2e 1–4, unit règles |
| Création de vente | membres actifs avec **`sales.notifications`** (propriétaire et admin par défaut) | nouvelle permission délégable ; quantité et montant seulement avec `sales.view_all` | centre + push regroupé par minute (existant) | e2e 6, 7, unit règles |
| Produit : création, modification (dont prix et stock), corbeille, restauration, suppression définitive | **propriétaire seul**, jamais pour ses propres actions | rôle `owner` | centre + push regroupé | e2e 8, 11, 12, spec contrôleur |
| Section : création, modification, corbeille, restauration, suppression définitive | propriétaire seul | rôle `owner` | centre + push regroupé | e2e 9 |
| Vente : modification, annulation | propriétaire seul | rôle `owner` | centre + push regroupé | e2e 10 |
| Invitation : création, révocation | propriétaire seul | rôle `owner` | centre + push regroupé | e2e 2, 5 |
| Membre : modification (rôle, permissions, statut) | propriétaire seul | rôle `owner` | centre + push regroupé | e2e 10 |
| Identité visuelle : nom, couleur, logo, retrait du logo | propriétaire seul | rôle `owner` | centre + push regroupé | e2e 10 |

### Inventaire des écritures déléguables

| Permission | Écritures | Couverture |
|---|---|---|
| `products.manage` | produit : création, modification, corbeille | couvert |
| `stock.adjust` | prix et ajout de stock (modification produit) | couvert (« modifié ») |
| `catalog.manage` | sections : création, modification, corbeille | couvert |
| `trash.manage` | restauration et suppression définitive (produits, sections) | couvert |
| `sales.record` | création | notification de vente |
| `sales.record` | modification, annulation | couvert (activité) |
| `members.invite` | création et révocation d'invitation | couvert |
| `members.manage` | modification de membre | couvert |
| `branding.manage` | identité visuelle | couvert |
| `support.contact` | message au service client | **exclu** : aucune donnée de l'organisation n'est modifiée |
| réservées au propriétaire | transfert de propriété, paiement | sans objet : l'auteur est le destinataire |
| consultations | `GET` | jamais notifiées |

### Contenu

- **Centre.** Le texte donne l'auteur, l'action et la cible, par exemple
  « Ali a mis à la corbeille le produit « Savon ». ». Pour une action
  groupée, il devient récapitulatif : « Ali a mis à la corbeille 3
  produits. ». La date est celle de l'événement. Les textes existent en
  français et en anglais (`Accept-Language`).
- **Noms figés.** Le nom de l'auteur, le nom de la cible et l'adresse
  invitée sont figés dans la notification. Une suppression définitive reste
  donc lisible.
- **Détail.** Un lien n'est proposé que si la cible existe encore dans
  l'organisation : produit, section, corbeille ou ventes. Une cible
  supprimée apparaît comme « (supprimé) », sans lien. La page cible applique
  ses contrôles d'accès habituels.
- **Push.** Le texte reste générique, comme en 1-16A : « Un collaborateur a
  modifié les données de votre entreprise. ». Aucun nom ni montant
  n'apparaît sur l'écran verrouillé.
- **Aucune donnée sensible.** Ni jeton, ni lien d'invitation, ni prix
  d'achat ou marge. Le montant d'une vente n'apparaît qu'avec
  `sales.view_all`.

### Permission `sales.notifications`

Aucune permission de réception n'existait : la règle précédente se fondait
sur `sales.view_all` et le rôle. La nouvelle permission délégable s'appelle
« Recevoir les notifications de ventes ». Elle est proposée dans
l'interface des permissions (membres et invitations), accordée par défaut au
propriétaire et à l'administrateur (union non réductible), et jamais au
vendeur sans ajout explicite.

L'ensemble des destinataires par défaut est identique à avant : le
propriétaire et les administrateurs. Aucune migration n'est nécessaire.

## 3. Fiabilité et limites honnêtes

- **Adhésion et vente.** L'événement est enregistré dans la transaction
  métier : il est perdu avec un rollback, jamais émis sans succès.
- **Activités.** L'événement est enregistré **après** le succès du service,
  en best effort : une panne n'annule jamais l'action.
  **Limite :** un arrêt du processus entre l'action et l'enregistrement perd
  cette notification. Rendre ces écritures transactionnelles demanderait de
  modifier chaque service ; c'est hors périmètre.
- **Livraison.** Elle passe par le dispatcher existant, après commit. Une
  panne du centre laisse le travail `pending`, repris à la passe suivante
  (e2e 7).
- **Déduplication.**
  - adhésion : clé `member-joined:<membership>` ;
  - vente : clé `sale-created:<vente>` (existante) ;
  - activité : `activityEventIds`. Une action déjà comptée bute sur l'index
    unique `{eventKey, userId}` : la reprise après crash est testée.
  - suppressions définitives et annulations de vente : clé stable par
    cible.
- **Regroupement.** Fenêtre fixe d'une minute par auteur, action et type de
  cible. Une action groupée qui chevauche deux fenêtres produit deux
  récapitulatifs. Un regroupement déjà lu redevient non lu s'il reçoit une
  nouvelle action. Le push part une seule fois, en fin de fenêtre.
- **Droits relus.** Ils sont vérifiés à la diffusion (membership active,
  rôle et permissions actuels, organisation active), à chaque envoi push et
  à chaque lecture. Une permission retirée masque aussitôt les
  notifications. Après un transfert de propriété, l'ancien propriétaire ne
  voit plus les activités.
- **Changement de comportement voulu.** L'auteur d'une vente, propriétaire
  compris, ne reçoit plus la notification de sa propre vente. Deux tests
  e2e 1-16A.1 ont été adaptés : un vendeur vend à la place du propriétaire.
- Les anciennes ventes en attente sans `actorId` relisent le vendeur sur la
  vente.
- Aucun nouveau canal e-mail. La création d'invitation n'envoie toujours
  aucun e-mail.

## 4. Preuves (locales)

| Contrôle | Résultat |
|---|---|
| Unitaires API (toutes suites) | 91 suites, **1688/1688** |
| E2E `member-activity-notifications` (nouveau, 15 scénarios, finition comprise) | 15/15 |
| Finition : e2e `membership-management`, `invitations`, `member-activity-notifications` (ciblés) | 71/71 |
| Finition : unitaires `organizations` et `notifications` (ciblés) | 268/268 |
| Finition : web 1-19A face à l'API **antérieure** (`origin/main`, exécution réelle, §8) | conforme |
| Recette navigateur locale, bureau et mobile, FR et EN (§9) | **33/33** |
| E2E complet avant finition (dont 3 suites adaptées) | **43 suites, 799 réussis**, 1 suite ignorée (préexistante) |
| API : `tsc` (build), ESLint, Prettier des fichiers touchés | OK |
| Web : `tsc --noEmit`, ESLint des fichiers touchés, `i18n:coverage --fail` | OK |

Scénarios e2e 1-19A :

1. compte existant ;
2. nouveau compte et invitation créée par un admin ;
3. refus et rollback ;
4. concurrence ;
5. révocation ;
6. ventes (permission, auteur, confidentialité, isolation, rejeu) ;
7. panne du centre ;
8. produits (groupé, détail après suppression, reprise, fenêtre suivante) ;
9. sections ;
10. membres, identité visuelle, modification et annulation de vente ;
11. temps réel et reconnexion ;
12. push regroupé générique ;
13. nettoyage historique ;
14. ancien formulaire de membre : `sales.notifications` conservée (§8) ;
15. retour arrière : inventaire et retrait idempotent (§8).

Les unitaires et e2e complets n'ont pas été relancés après la finition :
seuls les contrôles ciblés des fichiers modifiés l'ont été.

## 5. Déploiement

Aucune migration de données n'est obligatoire. Les index ne changent pas ;
les nouveaux champs sont optionnels.

**Ordre : API, puis web.**

1. **API d'abord.** L'ancien web fonctionne avec la nouvelle API :
   - le texte des nouvelles catégories est rendu par l'API ; l'ancien web
     n'en propose ni la préférence ni le détail enrichi ;
   - une invitation révoquée reste affichée « Révoquée » jusqu'au
     rechargement ;
   - l'ancien formulaire de membre ne retire plus `sales.notifications` à
     son insu (§8).
2. **Web ensuite.** Dans l'ordre inverse (web avant API), attribuer
   `sales.notifications` échoue : 400, rien n'est enregistré. Le message
   affiché est le texte brut, en anglais, du validateur (§8). Ce n'est pas
   silencieux, mais c'est une gêne inutile.
3. Après déploiement, optionnellement : aperçu, puis
   `migrate:purge-terminated-invitations --apply`.

**Retour arrière : web, puis API**, après le retrait de la permission.

1. **Inventaire, lecture seule.**
   `migrate:sales-notifications-permission`.
   - Il couvre les **deux seules** collections qui stockent des permissions
     délégables : `organizationmemberships` (tout rôle, tout statut) et
     `organizationinvitations` (en attente ou expirées).
   - Pourquoi tout rôle et tout statut : un administrateur ou un
     propriétaire a pu recevoir la permission explicitement avant un
     changement de rôle, et un membre suspendu peut être réactivé.
   - Pourquoi les invitations : une invitation en attente la recopierait
     dans la membership à l'acceptation.
   - Le JWT ne porte aucune permission.
2. **Aperçu du retrait** : `--strip`, aucune écriture.
3. **Retrait** : `--strip --apply`. Le traitement est idempotent ; les
   autres permissions restent intactes. Sans ce retrait, l'API antérieure
   refuse toute écriture d'un document porteur : modification du membre,
   ou acceptation de l'invitation, qui échoue en 500.
4. Redéployer le web 1-18E, puis l'API 1-18E.

Rien de tout cela n'a été exécuté sur une base réelle. Autres effets
d'un retour arrière :

- les notifications `member-*` deviennent invisibles (l'ancienne API filtre
  sur ses catégories) ;
- les clés de préférences ajoutées sont ignorées ;
- les travaux `member-*` en attente sont clos sans destinataire.

## 6. Fichiers

API :

- **Catégories et règles.** `push/schemas/push-category.ts`,
  `organizations/permissions.ts`, `notifications/member-activity.ts`
  (nouveau), `notifications/notification-retention.ts`,
  `push/push-messages.ts`.
- **Outbox, dispatcher, centre.** `push/push-outbox.service.ts`,
  `push/push-dispatcher.service.ts`,
  `notifications/notification-center.service.ts`,
  `notifications/notifications.module.ts`.
- **Schémas et DTO.** `push-job`, `notification`, préférences (centre et
  push).
- **Invitations.** `organizations/invitation-acceptance.service.ts`,
  `organizations/organizations.service.ts`,
  `organizations/organizations.module.ts`.
- **Enregistrement des activités.** Contrôleurs `products`, `sections`,
  `sales`, `organizations` (invitations, membres, identité visuelle),
  `sales.service.ts` (vendeur et nom figé), modules `products` et
  `sections`.
- **Nettoyage.** `migrations/purge-terminated-invitations.ts` (nouveau) et
  le script `package.json`.
- **Finition (compatibilité).** `organizations/permissions.ts` (catalogues
  et fusion), `organizations/organizations.service.ts` (`updateMembership`),
  `organizations/organization-members.controller.ts` (paramètre
  `permissionsCatalog`),
  `migrations/sales-notifications-permission.ts` (nouveau) et son script.

Tests API :

- **Unitaires.** `notifications/member-activity.spec.ts` (nouveau) ; specs
  adaptées : règles, permissions, contrôleurs, révocation.
- **E2E.** `test/member-activity-notifications.e2e-spec.ts` (nouveau) ;
  suites adaptées : `invitations`, `notification-center`,
  `web-push-notifications`.

Web :

- `lib/push-notifications.ts`, `lib/notifications.ts`,
  `lib/organization-permissions.ts` ;
- `app/app/notifications/[id]/page.tsx` (détails « nouveau membre »,
  « activité » et montant masqué) ;
- `app/app/organization/invitations/page.tsx` (une invitation révoquée
  disparaît de la liste) ;
- `i18n/resources/{fr,en}/{notifications,organization}.ts` ;
- finition : `lib/api.ts` (`updateMember` déclare le catalogue) et
  `lib/organization-permissions.ts` (`PERMISSION_CATALOG`).

## 7. Remarque sur les tests

Lors d'une exécution complète intermédiaire, `invitation-account-index`
a échoué une fois : un index `autoIndex` a été construit entre deux
lectures. Le test est passé seul, puis dans l'exécution complète finale. Il
s'agit d'un aléa de minutage, sans lien avec ce lot.

## 8. Compatibilité de `sales.notifications` (finition)

### Défaut trouvé et corrigé : retrait silencieux par un ancien formulaire

Le formulaire de modification d'un membre envoie la liste **complète** des
permissions supplémentaires qu'il affiche (`supplementaryOnly`). Un web
antérieur à 1-19A, par exemple un onglet ou une PWA non rafraîchis, ne
connaît pas `sales.notifications`. À la moindre modification du membre
(rôle, statut ou autre permission), il l'aurait retirée sans le dire.

**Correction.** Le client déclare le catalogue de permissions qu'il connaît
par un **paramètre de requête**, `PATCH
/organizations/members/:id?permissionsCatalog=2`. Ce choix évite deux
pièges :

- un champ du corps serait refusé (400) par l'API antérieure, qui rejette
  les champs inconnus (`forbidNonWhitelisted`) ;
- un en-tête personnalisé échouerait au contrôle préalable CORS de l'API
  antérieure, qui n'autorise que `Content-Type` et `Authorization`.

Côté API, sans déclaration ou avec une valeur invalide, le catalogue 1 (web
antérieur) est retenu. Les permissions déjà accordées que ce catalogue ne
connaît pas sont alors **conservées**.

- **Aucune élévation.** Seules des permissions déjà présentes sont
  conservées, et le contrôle anti-escalade porte sur la liste fusionnée.
- **Retrait explicite.** Le web 1-19A déclare le catalogue 2 : il peut
  retirer la permission.

Preuves : unitaires (fusion, analyse du paramètre, contrôleur) et e2e 14.
L'e2e 14 couvre un ancien formulaire côté propriétaire puis côté
administrateur, un catalogue falsifié traité comme le plus ancien, le
retrait par le web actuel, et une invitation portant la permission
recopiée à l'acceptation.

### Web 1-19A face à l'API antérieure : vérifié à l'exécution

Méthode : `origin/main` (`29bfd1a`) dans un worktree temporaire, hors du
dépôt et supprimé ensuite. Les requêtes exactes du nouveau web y ont été
rejouées.

| Requête du web 1-19A | API antérieure |
|---|---|
| `PATCH` membre `?permissionsCatalog=2`, permissions connues | **200** : paramètre ignoré |
| `PATCH` membre avec `sales.notifications` | **400**, membership inchangée |
| `POST` invitation avec `sales.notifications` | **400**, aucune invitation |
| `GET /notifications/preferences` | `available` sans `member-*` : le web n'affiche pas ces préférences |
| `PUT` préférences, une clé connue (seul envoi du web) | **200** |
| `PUT` préférences `memberJoined` | 400. Jamais envoyé par le web : il n'envoie que la clé basculée, et seulement pour une catégorie proposée par l'API |

Les préférences push ont été vérifiées dans le code : `PATCH` partiel,
mêmes catégories que celles annoncées par l'API.

**Limite restante.** Avec l'ordre inverse (web avant API), le 400 affiche le
message brut du validateur, en anglais. L'ordre API puis web l'évite.

## 9. Recette navigateur locale

Méthode :

- stack de recette locale (`recipe.js start --anti-bot=simulated`) ;
- MongoDB éphémère, e-mails dans un fichier, transport push simulé ;
- Chromium de Playwright, avec une installation existante, hors dépôt ;
- organisation neuve : propriétaire, administrateur et deux vendeuses ;
- propriétaire en bureau (1280 px) ; administrateur et vendeuse en mobile
  (390 px) ; FR puis EN.

Script et captures dans le répertoire temporaire de la session, hors dépôt.

Résultat : **33/33 contrôles**.

| # | Contrôle | Résultat |
|---|---|---|
| R1 | Invitation acceptée : la ligne disparaît chez le propriétaire sans rechargement. Le document est supprimé. L'admin (mobile) voit « … a rejoint votre entreprise. » en temps réel, et son compteur augmente de 1. La vendeuse sans `members.manage` ne reçoit rien. | OK |
| R2 | Invitation révoquée depuis l'interface : disparition immédiate | OK |
| R3 | Case « Recevoir les notifications de ventes » cochée dans le formulaire du membre, puis enregistrée | OK |
| R4 | Vente d'Awa : propriétaire, admin et Binta (`sales.notifications`) notifiés ; Awa (autrice) exclue | OK |
| R5 | Binta, sans `sales.view_all` : ni montant ni quantité dans la liste et le détail, mention affichée. Le propriétaire voit le montant. | OK |
| R6 | Produit modifié, mis à la corbeille puis supprimé définitivement par l'admin. Les trois textes sont lisibles. Les trois détails affichent « Savon Recette (supprimé) », sans aucun lien vers le produit. | OK |
| R7 | Restauration groupée de 3 produits depuis la corbeille de l'admin : « … a restauré 3 produits. » arrive en temps réel chez le propriétaire. Le compteur augmente d'une seule unité et la cloche est à jour. | OK |
| R8 | Préférences : FR « Nouveau membre » et « Actions des collaborateurs » chez le propriétaire, seulement « Nouveau membre » chez l'admin. Couper la catégorie masque les activités. EN : « New member », « Team activity », récapitulatif traduit, mention de montant masqué. | OK |
| R9 | Mobile : aucun défilement horizontal (admin et vendeuse, FR et EN) | OK |

Observations :

- **Bouton « Ouvrir » du détail d'une vente.** Il mène à la liste des
  ventes, soumise aux droits habituels. Une vendeuse sans `sales.view_all`
  n'y voit que ses propres ventes, pas celle qui est notifiée. C'est
  cohérent (aucune fuite), mais le lien lui est peu utile.
- **Push.** Il n'a pas été rejoué dans le navigateur ; il est couvert par
  l'e2e 12 (transport simulé).

Limites restantes :

- la perte possible d'une notification d'activité en cas d'arrêt du
  processus entre l'action et son enregistrement (§3) ;
- le message brut en ordre de déploiement inverse (§8) ;
- les regroupements qui chevauchent deux fenêtres d'une minute ;
- aucun parcours de rejet explicite par l'invité (non créé, conformément à
  la consigne).
