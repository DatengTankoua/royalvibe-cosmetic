# Phase 1-10B — Livraison des invitations Stock Master par email

**Branche** `architecture/phase-1-10b-invitation-email-delivery` · **Base** `08887f1` (1-10A) — aucun commit, aucun push, aucun accès réseau/Resend/Atlas/Supabase/27017 réel, aucun secret ni `.env` modifié (seul `api/.env.example`, gabarit sans secret, documente les 3 nouvelles variables en commentaire), aucun package ajouté (Resend implémenté en `fetch` natif Node).

> **Mise à jour (correction sécurité 1-10B)** : ajout d'un rate limiting dédié sur `POST /organizations/invitations` — voir §11. Même branche, aucun commit/push supplémentaire.

## 1. Contrat

`POST /organizations/invitations` (`members.invite`, inchangé côté autorisation) renvoie désormais, en plus de `{ invitation, token }` déjà existants (1-6B.1) :

```json
{ "invitation": { "...": "..." }, "token": "…", "delivery": { "status": "sent" | "manual" | "failed" } }
```

- **`sent`** : email accepté par le provider (Resend). Ne garantit jamais la remise réelle au destinataire, seulement l'acceptation par l'API du provider (§7 de la demande, respecté à la lettre — aucune formulation du type « email envoyé avec succès garanti »).
- **`manual`** : configuration email absente (typiquement dev/test local, comme dans toute la suite e2e existante) — **aucun appel réseau tenté**, l'invitation est créée normalement, le lien reste à partager manuellement (déjà le comportement du frontend avant cette phase).
- **`failed`** : provider en échec HTTP (statut non-2xx) ou time-out — l'invitation est **conservée telle quelle**, le token brut est **quand même renvoyé une seule fois** pour copie manuelle, réponse HTTP **201** (jamais 500), **aucune seconde invitation créée**.

Le test e2e historique (1-6B.1) qui vérifiait la forme exacte `Object.keys(body) === ['invitation', 'token']` a été mis à jour vers `['delivery', 'invitation', 'token']` — extension additive du contrat, pas une rupture (toutes les clés précédentes restent inchangées, `delivery` s'ajoute).

## 2. Configuration (uniquement lue, jamais de valeur de production par défaut)

| Variable | Rôle |
|---|---|
| `RESEND_API_KEY` | Clé API Resend (`Authorization: Bearer …`) |
| `EMAIL_FROM` | Expéditeur (`from`) |
| `PUBLIC_APP_URL` | Base **absolue http/https** du lien d'acceptation (`${PUBLIC_APP_URL}/auth/invitations/accept?token=…`) |

`ResendEmailService.readConfig()` (api/src/email/resend-email.service.ts) relit ces 3 variables à **chaque appel** (jamais mises en cache au constructeur, contrairement à `S3Service`) : dès qu'**une seule** est absente, ou que `PUBLIC_APP_URL` n'est pas une URL absolue `http:`/`https:` valide (`new URL(...)` + vérification du protocole), le service renvoie immédiatement `manual` — **zéro appel `fetch`**. Aucune des 3 n'a de valeur par défaut codée en dur.

`api/.env.example` documente les 3 variables en commentaire (optionnelles, aucune valeur secrète) ; aucun fichier `.env` réel n'a été touché.

## 3. Cycle création → email

`OrganizationsService.createInvitation` (inchangé jusqu'à la persistance de l'invitation — anti-escalade 1-9C, index unique partiel, gestion E11000 concurrente, tout conservé à l'identique) :

1. Toutes les vérifications existantes (permission `members.invite`, anti-escalade rôle/permissions ⊆ droits de l'acteur, `MEMBER_ALREADY_ACTIVE`, `INVITATION_ALREADY_PENDING`) restent **strictement avant** toute tentative d'email — vérifié par des tests dédiés (`emailServiceStub.sendInvitationEmail` non appelé sur chaque chemin de refus).
2. L'invitation est **créée en base** (`invitationModel.create`, hors toute transaction Mongo — ce flux n'en a jamais eu).
3. **Après** cette création réussie, `sendInvitationEmail()` (méthode privée) relit le **nom d'organisation** (`organizationModel.findById(...).select('name')`) puis appelle `EmailService.sendInvitationEmail({ to, organizationName, role, token, expiresAt })`.
4. Le résultat (`'sent' | 'manual' | 'failed'`) est capturé dans un `try/catch` dédié : **toute** erreur inattendue à cette étape (y compris une panne de lecture du nom d'organisation) retombe sur `'failed'`, **jamais** une exception ne remonte au contrôleur — la réponse HTTP reste 201 avec l'invitation déjà acquise.

## 4. Abstraction email

- `EmailService` (`api/src/email/email.service.ts`) : classe abstraite **injectable minimale**, une seule méthode `sendInvitationEmail(payload): Promise<EmailDeliveryStatus>` — ne rejette jamais, ne remonte jamais l'erreur brute du provider.
- `ResendEmailService` (`api/src/email/resend-email.service.ts`) : implémentation Resend via `fetch` natif Node (aucun package ajouté), `AbortController` avec timeout explicite (8 s, aucun retry automatique), sujet/texte/HTML construits localement — **HTML échappé** (`escapeHtml` maison sur `organizationName`, seule donnée client injectée), lien construit par `encodeURIComponent(token)`. Aucun log (succès ou échec) ne contient le token, la clé API ou la réponse complète du provider.
- `EmailModule` fournit `EmailService → ResendEmailService`, importé par `OrganizationsModule`.

## 5. Sécurité

- Autorisation/anti-escalade **1-9C réutilisées telles quelles** (aucune modification de cette logique) : `organizationId`/`invitedById` proviennent exclusivement de `OrganizationGuard`/`@CurrentUser` — une requête forgée ne peut ni l'un ni l'autre modifier (invariant déjà garanti, non touché par cette phase).
- Refus permission/validation/duplicate → **zéro appel email**, vérifié explicitement en unitaire ET en e2e (config Resend complète mais `fetch` jamais invoqué sur ces chemins).
- Timeout explicite (`AbortController`, 8 s) — jamais de requête pendante indéfiniment.
- Aucun secret dans les erreurs HTTP : l'échec du provider est absorbé en `'failed'`, jamais propagé avec un détail Resend.
- Token brut : jamais persisté (seul `tokenHash` SHA-256 en base, inchangé depuis 1-6B.1), jamais journalisé (vérifié par un test qui espionne `console.log/warn/error`).

## 6. Tests

**Unitaires** (`api/src/email/resend-email.service.spec.ts`, 13 tests ; `api/src/organizations/organizations.service.spec.ts`, complété) :
payload exact envoyé au provider (`from`/`to`/`subject`/`text`/`html`) ; URL du lien encodée (`encodeURIComponent`) ; nom d'organisation échappé (tentative d'injection `<script>` neutralisée) ; 6 scénarios de config absente/invalide → aucun `fetch` ; succès (2xx) → `sent` ; échec (non-2xx) → `failed` ; time-out/`AbortError` → `failed` ; `AbortSignal` bien transmis ; aucune fuite de token/clé dans les logs ; côté `OrganizationsService` : delivery `manual`/`sent`/`failed`, payload exact transmis à `EmailService`, et **aucun appel email** sur anti-escalade/refus/doublon.

**E2E** (`api/test/invitation-email-delivery.e2e-spec.ts`, nouveau fichier dédié, `global.fetch` systématiquement mocké — **jamais** de réseau réel) :
provider 2xx → 201 + `sent` ; provider 500 → 201 + `failed` + invitation unique conservée ; provider rejette (time-out) → 201 + `failed`, retry manuel sur le même email → 409 (aucun second document) ; permission refusée (seller sans `members.invite`) → 403, **zéro** appel `fetch` ; payload invalide (rôle `owner`) → 400, zéro appel, zéro écriture ; doublon `pending` → 409, zéro appel.
`api/test/invitations.e2e-spec.ts` (suite existante, jamais de config Resend) : mis à jour pour attendre `delivery: { status: 'manual' }` en plus de `invitation`/`token` — couvre nativement le cas « configuration absente » sur l'ensemble des 30 tests de cette suite (isolation tenant A/B et anti-escalade 1-9C inchangées, toujours vertes).

## 7. Résultats

- `pnpm test` (api, unitaires) : **40 suites / 681 tests**, tous verts (dont les 8 nouveaux de `invitation-rate-limiting.spec.ts` et le nouveau test de métadonnées dans `organizations.controller.spec.ts` — voir §11).
- `pnpm test:e2e` (api) : **11 suites / 215 tests**, tous verts (dont les 30 de `invitations.e2e-spec.ts`, les 6 de `invitation-email-delivery.e2e-spec.ts`, et les 4 nouveaux de `invitation-rate-limiting.e2e-spec.ts` — voir §11).
- `pnpm lint` (api) : 0 erreur (2 warnings pré-existants, fichiers non touchés par cette phase).
- `pnpm lint` (web) : 0 erreur, 0 warning.
- `pnpm build` (api, `nest build`) : succès.
- `pnpm build` (web, Next 16 Turbopack) : succès, mêmes **23 routes** qu'en 1-10A (aucune route ajoutée/retirée).
- `git diff --check` : propre (mêmes avertissements CRLF/LF préexistants qu'en 1-9B/1-9C/1-9D/1-10A, aucun conflit ni espace en fin de ligne).

## 8. Frontend

`CreateInvitationDialog` (`web/src/components/organization/create-invitation-dialog.tsx`) affiche désormais un message adapté au `delivery.status` reçu, **en plus** du lien Copier déjà existant (jamais retiré, quel que soit le statut) :
- `sent` : confirmation « Email envoyé à l'invité(e) », lien toujours copiable en secours.
- `manual` : explication que l'envoi automatique n'est pas configuré, partage manuel requis.
- `failed` : avertissement clair (icône + texte `destructive`) que l'email n'a pas pu être envoyé, invitation valable, lien à copier.
Le token brut reste **uniquement en mémoire** (état React `useState`, jamais `localStorage`/`sessionStorage`, jamais loggé) — aucun changement de ce principe déjà en place depuis 1-6B.1.

## 9. Procédure de configuration en production

1. Créer un compte/domaine vérifié Resend, générer une clé API.
2. Définir dans l'environnement de production (jamais dans un fichier commité) :
   - `RESEND_API_KEY=<clé Resend>`
   - `EMAIL_FROM=<adresse expéditeur vérifiée sur le domaine Resend>`
   - `PUBLIC_APP_URL=https://<domaine public de l'app web>` (URL absolue, sans slash final requis — normalisé côté service)
3. Aucune migration ni redémarrage spécial requis au-delà d'un redéploiement standard : la configuration est relue à chaque envoi (pas de cache à invalider).
4. Vérifier qu'aucune des 3 variables n'est absente/vide — sinon le comportement reste silencieusement `manual` (pas d'erreur bloquante, mais aucun email n'est envoyé).

## 10. Risques résiduels

- Aucun test avec un vrai compte Resend/domaine vérifié (hors périmètre — interdiction explicite d'accès réseau réel dans cette phase).
- Le libellé de rôle dans l'email (`Administrateur`/`Vendeur`) est une petite table locale au service email, indépendante de `ROLE_LABELS` du frontend — à surveiller en cas d'ajout futur d'un rôle invitable.
- Pas de re-test manuel de rendu HTML de l'email dans un client mail réel (Gmail/Outlook) — validé uniquement par les assertions unitaires sur le HTML généré.

## 11. Correction sécurité — rate limiting de `POST /organizations/invitations`

### 11.1 Audit préalable de l'infrastructure existante

`@nestjs/throttler` (0B.6) était déjà en place pour `POST /auth/login` (fenêtres `login-short`/`login-long`) et réutilisé tel quel pour `/auth/register` et `/auth/invitations/accept`, via `AuthThrottlerGuard` (`api/src/common/auth-rate-limiting.ts`). Ce garde trace par **IP** (`normalizeIp(req.ip)`, hérité de `ThrottlerGuard`) — cohérent pour des routes **publiques** où aucun utilisateur authentifié n'existe encore. `POST /organizations/invitations` est déjà authentifiée ET tenant-scopée (gardes globaux `JwtAuthGuard`→`OrganizationGuard`→`PermissionGuard`→`RolesGuard`) : appliquer `AuthThrottlerGuard` tel quel aurait tracé par IP (plusieurs comptes derrière un même NAT partageant un quota, ou un attaquant changeant d'IP contournant la limite) — **décision : ne pas réutiliser `AuthThrottlerGuard`**, création d'un garde spécialisé minimal, `InvitationCreateThrottlerGuard` (`api/src/common/invitation-rate-limiting.ts`), qui **hérite de `ThrottlerGuard`** (même classe de base, même mécanique) mais **surcharge `getTracker`**.

`ThrottlerModule` est **`@Global()`** (vérifié dans le code source du package) : un seul `ThrottlerModule.forRoot()` existe pour tout le projet (déclaré dans `AuthModule`). La nouvelle fenêtre nommée `invitation-create` est **fusionnée dans ce même appel unique** (`AUTH_THROTTLER_WINDOWS` exporté par `auth-rate-limiting.ts` + `createInvitationThrottlerWindow()`) — **aucun second `forRoot()`**, **aucun second stockage**, **aucun package ajouté**. Les deux gardes (`AuthThrottlerGuard` et `InvitationCreateThrottlerGuard`) partagent donc le MÊME `ThrottlerStorage` (mémoire), mais s'isolent explicitement des fenêtres de l'autre via `@SkipThrottle()` (§11.3) — sans quoi chaque garde évaluerait **toutes** les fenêtres nommées du registre global (comportement par défaut de `ThrottlerGuard.canActivate`, vérifié dans `throttler.guard.js`), avec le mauvais tracker.

### 11.2 Limite exacte

| Paramètre | Valeur |
|---|---|
| Fenêtre | `invitation-create` |
| Limite | **5 créations** |
| Fenêtre glissante (`ttl`) | **60 secondes** |
| Blocage (`blockDuration`) | **60 secondes** après dépassement |
| Route | `POST /organizations/invitations` **uniquement** |

`GET /organizations/invitations` et `POST /organizations/invitations/:id/revoke` ne portent **aucun** `@UseGuards` de rate limiting — garde attachée en décorateur de **méthode** sur `create()` uniquement, jamais au niveau du contrôleur, jamais globale.

### 11.3 Composition non sensible de la clé (tracker)

`InvitationCreateThrottlerGuard.getTracker(req)` renvoie **`${userId}:${organizationId}`** :
- `userId` = `req.user._id` (branché par `JwtAuthGuard`, un garde global qui s'exécute **avant** ce garde de méthode) ;
- `organizationId` = `req.organizationContext.organizationId` (branché par `OrganizationGuard`, également global, également avant) ;
- **jamais** l'IP, **jamais** l'email/le token/une clé API — vérifié par un test unitaire dédié (`invitation-rate-limiting.spec.ts`) qui construit une requête avec IP/en-tête `Authorization` factices et vérifie qu'ils n'apparaissent jamais dans le tracker.

Conséquence du choix `userId:organizationId` (testée explicitement, e2e `invitation-rate-limiting.e2e-spec.ts`) : un même utilisateur membre de **deux organisations** dispose de **deux quotas indépendants** (un par organisation) — le quota épuisé dans l'organisation A n'affecte jamais ses créations dans l'organisation B. Chaque named-throttler du registre global est en outre isolé par `generateKey()` (héritée, non modifiée) qui inclut déjà `ClassName-handlerName-throttlerName` dans le hash de la clé de stockage — aucune collision possible entre `invitation-create` et `login-short`/`login-long` même en partageant le même `ThrottlerStorage`.

Isolation croisée entre les 2 fenêtres du registre partagé, via `@SkipThrottle()` officiel du package (jamais de logique maison) :
- `AuthController` (classe) : `@SkipThrottle({ 'invitation-create': true })` — `AuthThrottlerGuard` (login/register/accept-invitation, tracker IP) n'évalue jamais la fenêtre `invitation-create`.
- `OrganizationsController.create()` (méthode) : `@SkipThrottle({ 'login-short': true, 'login-long': true })` — `InvitationCreateThrottlerGuard` n'évalue jamais les fenêtres de login.

### 11.4 Ordre permission → throttle (gardes existants inchangés)

`InvitationCreateThrottlerGuard` est une garde de **méthode** (`@UseGuards` sur `create()`), donc exécutée **après** les 4 gardes globaux (`JwtAuthGuard`→`OrganizationGuard`→`PermissionGuard`→`RolesGuard`, ordre fixé et inchangé dans `auth.module.ts`). Conséquence directe, vérifiée par test e2e dédié : un acteur sans `members.invite` reçoit **toujours 403** (`PermissionGuard`) et **ne consomme jamais** le quota `invitation-create` — cette garde ne s'exécute même pas dans ce cas. À l'inverse, le throttle s'exécute **avant** le `ValidationPipe` (comportement standard NestJS : gardes avant pipes) : une requête au payload invalide (400) consomme quand même le quota — comportement identique et déjà établi pour `AuthThrottlerGuard` sur `/auth/register`, non modifié ici.

### 11.5 Contrat de réponse en cas de dépassement

Même **forme** de contrat stable que le rate limiting existant (`{ statusCode, code, message }` + en-tête `Retry-After` en secondes entières positives, `setHeaders: false` pour supprimer les en-têtes `X-RateLimit-*` automatiques) mais **code/message dédiés** (`INVITATION_RATE_LIMITED`, message sans rapport avec une connexion) — réutiliser tel quel `AUTH_RATE_LIMIT_CODE` (« Trop de tentatives de connexion ») aurait été trompeur pour une création d'invitation. Aucune donnée d'invitation (email/rôle/token) ni compteur exact dans le corps 429 — vérifié explicitement.

### 11.6 Limite mono-instance (pilote) — Redis obligatoire avant scaling

Même limite déjà documentée pour le login (0B.6), qui s'applique **identiquement** à cette nouvelle fenêtre puisqu'elle partage le même `ThrottlerStorage` mémoire : stockage **en mémoire du process**, correct pour une **seule instance d'API**. Si l'API est répliquée horizontalement (plusieurs instances derrière un load balancer), **chaque instance a son propre compteur** — un acteur pourrait multiplier son quota effectif par le nombre d'instances (ex. 5 × 3 instances = 15 créations réelles avant blocage uniforme). **Un stockage partagé (Redis, via `ThrottlerModuleOptions.storage`) est OBLIGATOIRE avant tout déploiement horizontal** — aucun changement de code applicatif requis au-delà de fournir cette option lors du `forRoot()`.

### 11.7 Tests ajoutés

**Unitaires** (`api/src/common/invitation-rate-limiting.spec.ts`, 8 tests ; `api/src/organizations/organizations.controller.spec.ts`, +1 test) :
fenêtre exacte (5/60s/60s) ; corps 429 stable exact ; tracker `userId:organizationId` (jamais IP/token) ; repli explicite si user/org absents ; deux organisations pour le même utilisateur → trackers distincts ; `canActivate` autorise sous la limite ; dépassement → `HttpException` 429 + `Retry-After` positif ; métadonnées `@SkipThrottle` exactes sur `create()`.

**E2E** (`api/test/invitation-rate-limiting.e2e-spec.ts`, nouveau fichier dédié, 4 tests, storage throttler réinitialisé en `beforeEach` — **aucun sleep**) :
5 créations autorisées puis la 6ᵉ → 429 (contrat stable, `Retry-After`, **zéro invitation** et **zéro appel `fetch`/EmailService** pour la requête bloquée) ; compteur isolé entre deux utilisateurs distincts de la même organisation ; même utilisateur dans deux organisations → quotas indépendants (comportement explicite, testé) ; `GET`/`revoke` jamais impactés même après épuisement du quota de création (10 `GET` + 5 `revoke` consécutifs, tous 200).
`api/test/invitations.e2e-spec.ts` et `api/test/invitation-email-delivery.e2e-spec.ts` (suites existantes, réutilisant les mêmes acteurs sur de nombreux `it()`) : `beforeEach` ajouté pour réinitialiser le `ThrottlerStorage` avant chaque test — sans quoi la nouvelle fenêtre `invitation-create` (5/60s) aurait fait échouer plusieurs tests préexistants en cours de suite (régression détectée puis corrigée avant validation finale).

Aucun commit, aucun push — en attente de validation.
