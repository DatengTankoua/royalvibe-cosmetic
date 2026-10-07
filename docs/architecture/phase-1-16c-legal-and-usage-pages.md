# Lot 1-16C — Pages juridiques et guide d'utilisation

> **Avertissement (modèle juridique).** Les textes produits dans ce lot sont
> des **projets rédigés à titre d'information**. Ils ne constituent pas un
> avis juridique et n'ont été validés par aucun juriste camerounais. Ils
> doivent être relus par un professionnel qualifié avant toute publication
> définitive. (Avertissement repris du skill `legal-advisor`, adapté au
> Cameroun.)

## 0. Base, périmètre et règles suivies

- Branche `architecture/phase-1-16c-legal-and-usage-pages`, créée depuis
  `12f8dc5` (« feat(web): modernize public homepage and fix Geist font »),
  sans changer l'arbre de travail. Ce commit contient l'intégralité du lot
  1-16B (accueil, captures, correction de Geist).
- État initial : arbre et index propres ; `stash@{0}` (sauvegarde
  lint-staged `564a998`), présent et **non touché**.
- Aucun commit, push, déploiement ni changement de configuration externe.
  Aucun `.env` réel ouvert, aucune base réelle, aucun contact client.
- API **non modifiée** : aucun test API relancé (justification au § 7).
  CamPay reste `UnavailablePaymentProvider`, le webhook reste désactivé.
- Aucune dépendance ajoutée, aucun script tiers exécuté.

## 1. Skill et sources consultées

### 1.1 Skill

| Élément | Référence | Consulté le |
|---|---|---|
| `legal-advisor` (sickn33/agentic-awesome-skills) | `skills/legal-advisor/SKILL.md`, dernier commit du fichier `342019cb09fdbd66921bea74dc6f995aff746b64` (5 sept. 2026) | 6 oct. 2026 |
| `resources/implementation-playbook.md`, référencé par le skill | **404 : le fichier n'existe pas** dans le dépôt | 6 oct. 2026 |

Usage : méthode seulement (identifier le droit applicable, mentions
obligatoires, sections structurées, emplacements à compléter, signalement
des points à faire revoir, avertissement). Le skill est centré sur le RGPD,
le CCPA et d'autres régimes étrangers : **aucun de ces modèles n'a été
transposé**, ni aucune clause de tribunal, d'arbitrage ou de renonciation
aux droits.

### 1.2 Sources officielles

Toutes consultées le 6 octobre 2026. Les textes scannés ont été lus page
par page ; aucun OCR n'est installé et aucun n'a été ajouté.

| Texte | Source | Empreinte SHA-256 du fichier | Forme |
|---|---|---|---|
| Loi n° 2024/017 du 23 décembre 2024 relative à la protection des données à caractère personnel au Cameroun | Présidence de la République, copie certifiée conforme : `https://www.prc.cm/files/2b/9f/21/1055fa3c2251b4c4248fd301f584daaf.pdf` (fiche `prc.cm/fr/actualites/actes/lois/7588`) | `3fd7aea48aa88c6987ce1a1801d27c9632d3e52e1d2c940e90312e12f85f74de` | Scan, 24 pages, lu intégralement |
| Loi n° 2010/021 du 21 décembre 2010 régissant le commerce électronique | MINCOMMERCE : `mincommerce.gov.cm/sites/default/files/documents/loi-n-2010-021-du-21-decembre-2010-regissant-le-commerce-electronique-au-cameroun.pdf` | `9de226fffa2e1e5eba1a22b49a6e1f808078b3df171f848271af103a93760a69` | Texte, lu intégralement |
| Décret n° 2011/1521/PM du 15 juin 2011 fixant les modalités d'application de la loi 2010/021 | MINCOMMERCE : `…/decret-n-2011-1521-pm-du-15-juin-2011-fixant-les-modalites-d-application-de-la-loi-regissant-le-commerce-electronique-au-cameroun.pdf` | `0a01177af4de70e9058ba1ad7e4bdf01f41544846783ad5f54a296a9b56f01db` | Scan, 7 pages, lu intégralement |
| Loi-cadre n° 2011/012 du 6 mai 2011 portant protection du consommateur | ART : `art.cm/sites/default/files/documents/loi_cadre_2011_012_06052011_protect_conso.pdf` | `38b2897a5a4c304d7d7ee22cd56b48b0eb5d49f649da9d8576031454405e20a6` | Texte, lu intégralement |

Limites : les versions MINCOMMERCE et ART n'ont pas été comparées au
Journal officiel. La loi n° 2010/012 relative à la cybersécurité et à la
cybercriminalité n'a **pas** été analysée (voir § 5.2).

### 1.3 Vérifié et à faire confirmer

| Point | Statut |
|---|---|
| Loi 2024/017 en vigueur dès sa promulgation ; délai de mise en conformité de 18 mois (art. 73), **expiré le 23 juin 2026** | Vérifié (texte) |
| Consentement préalable, libre, éclairé, spécifique et univoque comme **principe** (art. 9 (1)) ; trois dérogations seulement : obligation légale, mission d'intérêt public, santé (art. 9 (2)). **Pas** de base « exécution du contrat » ni « intérêt légitime » | Vérifié (texte) ; conséquences à faire valider |
| Autorisation **préalable** de l'Autorité pour tout traitement (art. 19, 49) et pour tout transfert vers un État étranger (art. 32) ; sanctions administratives et pénales (art. 55, 60, 69) | Vérifié (texte) |
| Création de l'Autorité par décret présidentiel (art. 53 (2)) | Vérifié (texte). **Aucun décret publié trouvé** : seul un projet de décret (MINPOSTEL, 2023) apparaît ; des commentaires de 2025 la disent non opérationnelle. À confirmer |
| Durées de conservation fixées par un référentiel de l'Autorité (art. 13, 28) | Référentiel non trouvé |
| « Transactions bancaires » parmi les données sensibles (art. 5) ; autorisation pour les traiter (art. 48 (2)) | Vérifié ; portée pour un paiement Mobile Money à faire qualifier |
| Profilage pénalement sanctionné (art. 65) | Vérifié ; le « classement vendeurs » de l'écran Analyse est à faire qualifier |
| Informations à fournir aux personnes (art. 21), notification des violations sans délai (art. 22), registre (art. 29), contrat avec le sous-traitant (art. 30), rapport annuel (art. 27 (2)) | Vérifié (texte) |
| Commerce électronique : identification du prestataire (loi art. 30 ; décret art. 5 : adresses électronique et **postale**, téléphone, prix TTC, **directeur de publication**, informations accessibles depuis la page d'accueil) | Vérifié (texte) |
| Conservation **10 ans** de l'écrit d'un contrat électronique **≥ 20 000 FCFA** (décret art. 8 et 22). La formule 12 mois à 30 000 FCFA est concernée | Vérifié (texte) ; application à valider |
| Rétractation : 15 jours (loi 2010/021 art. 20), **15 jours ouvrables** et 3 mois si l'information est incomplète (décret art. 13), 14 jours (loi-cadre art. 7). Exclusion pour un service commencé avec accord « sauf convention contraire » (décret art. 15) | Vérifié ; **incohérence entre les textes** à arbitrer par un juriste |
| Preuve de l'information et du consentement à la charge du prestataire (loi 2010/021 art. 26 ; décret art. 12 ; loi-cadre art. 28) | Vérifié (texte) |
| Contrats d'adhésion et information en **français et en anglais** (loi-cadre art. 6 et 13) | Vérifié ; application aux commerçants (consommateurs ?) à qualifier |
| Nullité des clauses limitant la responsabilité et des clauses d'arbitrage unilatérales (loi-cadre art. 5 et 35) ; responsabilité de plein droit et obligation de résultat du fournisseur électronique (décret art. 25-26) | Vérifié ; aucune clause de ce type rédigée |

## 2. Audit ciblé (code et rapports, avant rédaction)

### 2.1 Données

| Domaine | Données (schémas API) | Rôle de Stock Master |
|---|---|---|
| Compte | `User` : nom, e-mail, mot de passe haché (bcrypt), confirmation (date, jeton haché, expiration 24 h, compteurs), réinitialisation (jeton haché, 1 h), `authVersion` | Responsable |
| Commerce | `Organization` : nom, slug, logo, couleur, devise, statut | Responsable (paramétrage) |
| Membres | `Membership` : rôle, permissions, statut (`active`, `suspended`, `revoked`), invité par, date d'arrivée | Responsable du compte ; activité = commerce |
| Invitations | e-mail, rôle, permissions, jeton haché, statut, expiration 72 h. Lien remis par le créateur (aucun e-mail envoyé, 1-12G) | Responsable / commerce |
| Ventes | produit, nom du produit (instantané), quantité, prix, date, vendeur, **`buyerName`, `buyerContact` facultatifs** ; opérations idempotentes | **Sous-traitant** pour le commerce |
| Catalogue, fichiers | sections, produits (prix d'achat et de vente, stock), images et logos dans le stockage S3 (Supabase) ; purge définitive = suppression du fichier | Sous-traitant |
| Journaux | `AuditLog` (organisation, produit, action, acteur, détails ; annulation de vente sans données acheteur) ; bilans mensuels | Sous-traitant |
| Abonnement | périodes (type, durée, dates, origine) ; paiements (montant, durée, références, statut, **téléphone du payeur masqué**), rapprochements | Responsable |
| Notifications | notifications (type, lecture, `expiresAt`), préférences par catégorie, abonnements push (endpoint, clés, désactivation), files d'envoi | Responsable |
| Technique | limitation des connexions par adresse IP, **en mémoire** (perdue au redémarrage) ; journaux des hébergeurs : inconnus | Responsable |

Aucun champ ni collection ne porte une **acceptation de conditions**, une
**version de document** ou une **préférence marketing**.

### 2.2 Fournisseurs

| Fournisseur | Intégré | Activé en production |
|---|---|---|
| Vercel (web) | Oui (workflows `deploy`/`rollback`) | Observé en 1-14D.2E.1 ; région inconnue |
| Railway (API) | Oui (README, déploiements GitHub) | Observé ; version en service indéterminée |
| MongoDB Atlas | Oui | « Selon D9 » ; non vérifié |
| Supabase Storage (S3) | Oui | « Selon D9 » ; non vérifié |
| Resend (e-mail) | Oui | Non vérifié (`RESEND_API_KEY`, `EMAIL_FROM`) |
| Web Push (VAPID) | Oui | `WEB_PUSH_ENABLED=false` par défaut ; non vérifié |
| CamPay | Oui | **Non** : `UnavailablePaymentProvider` |
| Namecheap / cPanel | Domaine et messagerie prévue | Ne prouvent rien sur l'hébergement de l'application |

Aucun outil de mesure d'audience, de publicité ni de suivi d'erreurs tiers.
Polices Geist auto-hébergées par `next/font` (aucune requête navigateur
vers Google).

### 2.3 Stockage sur l'appareil

- **Cookies : aucun** (ni `document.cookie`, ni `Set-Cookie` dans l'API).
- `localStorage` : `heyama_token` (JWT, 7 jours), `heyama_user` (id, nom,
  e-mail, rôle), `stockmaster_commercial_blocks`,
  `stockmaster_payment_intents`, `stockmaster.pwa.installed`,
  `stockmaster.engagement.lastModalAt`.
- `sessionStorage` : `stockmaster_restricted_session` (15 min),
  `stockmaster.engagement.bannerHidden`.
- IndexedDB : `stockmaster-offline-catalog` (72 h, sans prix d'achat),
  `-identity`, `-sales-capability` (72 h), `-tenant-brand`,
  `-sales-outbox` (200 ventes au plus, 14 jours en attente, 7 jours après
  l'envoi ; peut contenir des données acheteur). La déconnexion et le bouton
  « Supprimer les données hors connexion » purgent tout **sauf** l'outbox.
- Service worker : cache `stockmaster-v3` de pages publiques et d'assets ;
  jamais de jetons ni de liens sensibles.

### 2.4 Conservation

Établies : confirmation 24 h, réinitialisation 1 h, invitation 72 h, JWT
7 jours, session limitée 15 min, notifications lues 48 h à 30 jours,
données hors ligne ci-dessus. **Indécises** : notifications non lues,
abonnements push désactivés, invitations expirées, comptes, données des
commerces, journaux d'audit, paiements (hors obligation de 10 ans), files
push, journaux des hébergeurs.

### 2.5 Export, suppression, assistance, acceptation

- **Export** : seulement l'export local des ventes en attente (JSON/CSV).
  Aucun export de compte ni de commerce.
- **Suppression** : vente (avec remise en stock et trace d'audit), produit
  et section (corbeille, puis purge), logo. **Aucune** suppression de
  compte ni de commerce, aucune modification du nom ou de l'e-mail.
  Retrait d'accès d'un membre par statut, transfert de propriété.
- **Assistance** : aucun canal dans le code avant ce lot.
- **Acceptation des conditions** : **inexistante** (voir § 4).

## 3. Pages et fichiers

### 3.1 Créés

| Fichier | Rôle |
|---|---|
| `web/src/lib/legal/site-identity.ts` | Source **unique** : nom, domaine, adresses e-mail prévues (`CONTACT_EMAILS_VERIFIED = false`), identité de l'exploitant (tout à `null`), prestataires documentés (pays à `null`), registre des documents (statut « projet », version 0.1, date) |
| `web/src/lib/legal/document-metadata.ts` | Titre, description ; `noindex` tant qu'un document est un projet |
| `web/src/components/legal/document-page.tsx` | Gabarit : en-tête et pied communs, lien d'évitement, h1, version, bandeau « Projet », sommaire généré depuis les sections (h2), sections ancrées sous l'en-tête collant |
| `web/src/components/legal/missing.tsx` | `Missing` et `Known` : marqueur visible « À compléter : … », jamais de valeur plausible |
| `web/src/components/legal/mail-link.tsx` | Liens `mailto:` vers les adresses centralisées |
| `web/src/components/legal/auth-legal-links.tsx` | Liens d'aide et d'information sous les formulaires de connexion et d'inscription |
| `web/src/components/public/public-header.tsx` | En-tête des pages publiques secondaires (logo, Guide, Contact), sans session |
| `web/src/components/public/public-footer.tsx` | Pied de page commun : produit, aide et compte, 6 documents légaux ; lien d'inscription selon le flag |
| `web/src/app/mentions-legales/page.tsx` | Mentions légales (projet) |
| `web/src/app/conditions-utilisation/page.tsx` | Conditions d'utilisation (projet) |
| `web/src/app/conditions-abonnement/page.tsx` | Conditions d'abonnement (projet), prix rendus depuis `lib/subscription-offers.ts` |
| `web/src/app/confidentialite/page.tsx` | Politique de confidentialité (projet) |
| `web/src/app/cookies/page.tsx` | Cookies et stockage sur l'appareil (projet) |
| `web/src/app/traitement-donnees/page.tsx` | Accord de traitement des données (projet) |
| `web/src/app/guide/page.tsx` | Guide d'utilisation avec sommaire (indexable) |
| `web/src/app/contact/page.tsx` | Contact par liens e-mail (indexable, avertissement « adresses en cours d'activation ») |
| `docs/architecture/phase-1-16c-captures/*.png` | 8 captures de recette |
| `docs/architecture/phase-1-16c-legal-and-usage-pages.md` | Ce rapport |

### 3.2 Modifiés

| Fichier | Changement |
|---|---|
| `web/src/app/page.tsx` | Le pied de page de l'accueil devient `<PublicFooter onHome />` (mêmes ancres, plus aide et documents légaux) |
| `web/src/app/auth/login/page.tsx` | `AuthLegalLinks` sous le formulaire |
| `web/src/app/auth/register/page.tsx` | Phrase d'information avant « Créer mon entreprise » (liens vers les 3 textes, « en cours de finalisation »), `AuthLegalLinks` sous le formulaire et sur l'écran « Inscription désactivée ». **Aucune case**, aucune acceptation simulée |
| `web/src/app/app/layout.tsx` | Entrée « Aide » (`/guide`, icône `CircleHelpIcon`) dans la navigation du shell ; sur mobile, elle passe dans « Plus » ; hors ligne, elle est désactivée comme les autres pages par `ShellNavLink` |

Inchangés : API, service worker, flags, règles d'accès, harnais de recette,
identifiants techniques (`heyama_*`, `stockmaster-*`).

## 4. Acceptation des conditions : défaut et correction nécessaire

**Constat.** L'inscription n'affiche aucune case et l'API n'enregistre
aucune acceptation : ni champ, ni version, ni date, ni collection. Les
liens ajoutés dans ce lot sont **informatifs** ; ils ne prouvent rien et ne
sont présentés nulle part comme une acceptation. Les conditions affichent
dans leur bandeau qu'elles ne sont pas encore opposables.

**Pourquoi c'est bloquant.** La preuve de l'information et du consentement
incombe au prestataire (loi 2010/021 art. 26 ; décret art. 12) ; l'écrit
d'un contrat ≥ 20 000 FCFA doit être conservé 10 ans (décret art. 8) ; la
loi 2024/017 exige un consentement spécifique (art. 9).

**Correction proposée (lot API dédié, non réalisée ici) :**

1. Versionner chaque document (identifiant et empreinte du texte publié) ;
   archiver chaque version publiée.
2. Inscription : case **non cochée** « J'accepte les conditions
   d'utilisation et d'abonnement » + information confidentialité ; refus
   serveur (400) si absente ou si la version envoyée n'est pas la version
   courante.
3. Enregistrement **côté serveur**, dans la même transaction que la
   création du compte : utilisateur, documents et versions, date serveur.
   Conservation alignée sur l'obligation de 10 ans à valider.
4. Même mécanisme pour l'acceptation d'une invitation et pour le
   propriétaire lors d'un achat (conditions d'abonnement et rétractation).
5. Nouvelle version : nouvel accord demandé à la connexion suivante.
6. Garder séparés : (a) conditions du service, (b) préférences marketing
   (**aucune n'existe ; ne pas en créer sans consentement distinct**),
   (c) permission native de notification, déjà séparée (action explicite
   dans Organisation → Notifications, puis demande du navigateur).
7. Tests API ciblés (inscription, acceptation d'invitation) et recette.

## 5. Concordance textes ↔ fonctionnalités

### 5.1 Affirmations publiques et preuves

| Affirmation | Preuve |
|---|---|
| Aucun cookie, aucune mesure d'audience ni publicité | § 2.3 ; dépendances web ; aucun script tiers |
| Mot de passe 6 à 100 caractères, haché | `password-policy.ts`, `RegisterDto`, `bcrypt.hash(…, 10)` |
| Lien de confirmation 24 h, réinitialisation 1 h, invitation 72 h, connexion 7 jours | `EMAIL_VERIFICATION_TTL_MS`, `PASSWORD_RESET_TTL_MS`, `INVITATION_TTL_MS`, `expiresIn: '7d'` |
| Invitation par lien copié, aucun e-mail envoyé, lien affiché une fois | `create-invitation-dialog.tsx` (1-12G) |
| Rôles propriétaire, administrateur, vendeur ; droits par défaut | `permissions.ts` (`ROLE_PERMISSIONS`), `PERMISSION_LABELS` |
| Statuts « Suspendue », « Révoquée », « Transférer la propriété » | `edit-member-dialog.tsx`, `members/page.tsx` |
| Essai de 7 jours à la création du commerce, un seul par commerce | `TRIAL_DURATION_MS`, `grantTrial` (index unique) |
| Prix 3 000 / 8 500 / 16 000 / 30 000 FCFA | Rendus depuis `lib/subscription-offers.ts`, identique à `subscription-pricing.ts` (vérifié en 1-16B) |
| Mois calendaires, borne au dernier jour du mois ; renouvellement à la fin de la couverture | `addUtcMonthsClamped`, `computeRenewalStartsAt` |
| Paiement en ligne indisponible ; aucun prélèvement automatique | `UnavailablePaymentProvider` ; libellé de l'écran Abonnement |
| Expiration : blocage de tout le commerce, y compris les sessions ouvertes ; écrans propriétaire et membres | `subscription-access.ts` ; `commercial-block-screen.tsx` |
| Données non supprimées automatiquement à l'expiration | Aucune purge dans le code |
| Hors ligne : 72 h, catalogue et vente seulement, stock indicatif, 200 ventes et 14 jours, export JSON/CSV, outbox conservée à la déconnexion | `offline-*` ; `offline-sales-policy.ts` ; `pending-sales-panel.tsx` ; `offline-purge.ts` |
| Supprimer une vente remet le stock | `SalesService.remove` (`adjustStock`) |
| Corbeille, restauration, purge du fichier, historique des ventes conservé | 1-15D ; `products.controller` |
| Rappel 24 h avant l'échéance ; catégories de notifications | `SUBSCRIPTION_REMINDER_WINDOW_MS` ; `CATEGORY_LABELS` |
| Notifications lues supprimées de 48 h à 30 jours | `notification-retention.ts` |
| Appareil injoignable désactivé automatiquement | `push-dispatcher` (404/410 → `disableSubscription`) |
| Push Android et iPhone **non testés** sur appareils réels | Écrit tel quel dans le guide ; rien n'est présenté comme validé |
| Libellés d'écran cités (« Enregistrer une vente », « Placer dans la corbeille », « Supprimer définitivement », « Activer / Désactiver les notifications », « Installer », « Mot de passe oublié ? », « Supprimer les données hors connexion », « Nouvelle section ») | Relevés dans les composants correspondants |

### 5.2 Points volontairement non affirmés

Aucune identité, adresse, immatriculation, qualité de DPO ni pays
d'hébergement n'a été inventé ; aucune fiscalité, aucun remboursement,
aucune procédure opérateur, aucun délai de réponse, aucun niveau de
service ni aucune procédure de suspension. Ces éléments sont signalés « À
compléter ». Aucune base « contrat » ni « intérêt légitime » n'est
invoquée ; aucun consentement global. La loi sur la cybersécurité
(2010/012) n'a pas été analysée : le besoin de consentement pour le
stockage sur l'appareil est donc marqué « à confirmer ».

## 6. Renseignements manquants et décisions à valider

Nombre de marqueurs « À compléter » affichés : mentions légales 16,
conditions d'utilisation 8, conditions d'abonnement 6, confidentialité 24,
cookies 1, traitement des données 14, contact 2, guide 0.

### 6.1 Identité et coordonnées (à fournir par le propriétaire)

1. Nom légal ou raison sociale, statut juridique, adresse professionnelle
   et **postale** (réclamations), téléphone.
2. RCCM, numéro d'identifiant unique (contribuable), capital social s'ils
   sont applicables ; régime fiscal et mention TTC.
3. Directeur de la publication.
4. Titulaire des droits sur la marque et le logo ; dépôt éventuel.
5. Fonctionnement réel des 4 adresses e-mail (envoi **et** réception), puis
   `CONTACT_EMAILS_VERIFIED = true` (devenu `CONTACT_EMAILS_STATUS` en
   1-16C.1). L'expéditeur reste la configuration `EMAIL_FROM` existante,
   une adresse du domaine vérifié chez Resend.
6. Pour chaque hébergeur : raison sociale, adresse, pays et région réels
   (tableaux de bord Vercel, Railway, Atlas, Supabase, Resend), contrats
   et accords de traitement.

### 6.2 Décisions juridiques (avec un juriste au Cameroun)

1. Fondements de chaque traitement au regard de l'art. 9 (absence de base
   « contrat ») ; forme du consentement à l'inscription.
2. Démarches auprès de l'Autorité : autorisation préalable (art. 19) et
   autorisation des **transferts** hors du Cameroun (art. 32), alors que
   l'Autorité ne semble pas opérationnelle.
3. Qualification du **classement des vendeurs** au regard du profilage
   (art. 65, sanction pénale).
4. Traitement futur des paiements Mobile Money au regard des « transactions
   bancaires » (art. 5, 48 (2)).
5. Commerçants « consommateurs » ou non ; conséquences : **version
   anglaise** (loi-cadre art. 6 et 13), rétractation, clauses abusives.
6. Règle de rétractation et de remboursement (textes divergents : 14 jours,
   15 jours, 15 jours ouvrables).
7. Âge minimum des comptes (art. 9 (3)).
8. Droit applicable et règlement des litiges (sans clause imposée).
9. Conservation de 10 ans des opérations ≥ 20 000 FCFA.

### 6.3 Décisions opérationnelles (exploitant)

1. Procédure de **renouvellement** tant que le paiement en ligne est fermé :
   moyens de paiement, justificatif, délai d'activation (le script
   `subscription:grant` existe côté opérateur ; aucune procédure client
   n'est confirmée).
2. Arrêt anticipé et remboursement.
3. Durées de conservation (§ 2.4) et suppression des données d'un commerce
   après la fin.
4. Procédure de suppression de compte et d'export sur demande (aucune
   fonction dans l'application), délais de réponse.
5. Gestion des incidents et délai de notification.
6. Niveau de service, annonce des interruptions, procédure de suspension.
7. Sauvegardes, chiffrement au repos, reprise (à vérifier chez les
   hébergeurs).
8. Registre des traitements (art. 29), engagement de confidentialité des
   personnes habilitées, DPO éventuel.
9. Mise en place de l'acceptation versionnée (§ 4).

## 7. Contrôles réellement exécutés

Tous sur l'environnement isolé : stack de recette éphémère (MongoDB en
mémoire, comptes fictifs, aucun `.env`), Playwright 1.62.1 existant hors
dépôt, Chromium 1234.

| Contrôle | Résultat |
|---|---|
| `npx eslint` (web, sans `--fix`) | exit 0 |
| `npx tsc --noEmit` (web) | exit 0 |
| `node api/test/recipe/recipe.js isolated web-build` | 1er passage : compilation réussie (8 nouvelles routes prérendues en statique), puis **exit 1** au nettoyage : `EBUSY: rmdir .stockmaster-recipe-web` (verrou Windows, aucun processus de recette actif). Copie supprimée par `removeIsolatedWeb` du harnais (`web/node_modules` intact vérifié). 2e passage : **exit 0**, `excludedEnvFilesByName: 3`, `envFilesInCopy: 0`, copie supprimée |
| `git diff --check` | exit 0 ; aucun espace en fin de ligne dans les nouveaux fichiers |
| Recette pages, inscription **ouverte**, code final | **49/49** |
| Recette pages, inscription **fermée** (build isolé `NEXT_PUBLIC_REGISTRATION_ENABLED=false`, sans API) | **45/45** |
| Recette accueil 1-16B (régression du pied de page) | **22/22** |

Contenu des recettes « pages » (scripts de travail hors dépôt, harnais
existant) :

- 8 routes × 3 largeurs (390, 1440, 320 px) : HTTP 200, un seul h1, aucun
  niveau de titre sauté, sommaire = sections et toutes les ancres
  présentes, aucun débordement horizontal, images avec `alt`, `mailto`
  limités aux 3 adresses prévues, bandeau « Projet » et `noindex` sur les 6
  documents, pages d'aide indexables ;
- sommaire : clic sur la dernière entrée, cible visible sous l'en-tête ;
- pied de page de l'accueil et d'une page juridique : 6 documents, guide,
  contact, connexion ; lien d'inscription présent seulement si ouverte ;
- connexion et inscription : 5 liens d'aide et d'information, sans
  débordement ;
- 88 liens internes (87 fermée) : cibles 200 et ancres présentes ;
- clavier (bureau, confidentialité et guide) : premier Tab sur « Aller au
  contenu », activation qui place le focus sur `#contenu`, contour visible
  sur chaque élément atteint, aucun élément focalisé caché par l'en-tête ;
- 0 erreur console, 0 réponse ≥ 400, 0 requête en échec (hors annulations
  de navigation) ;
- session **ouverte** (bureau et mobile) : 8 pages en 200 sans
  redirection ; entrée « Aide » du shell (via « Plus » sur mobile) mène à
  `/guide` ;
- session **limitée** (bureau et mobile) : 8 pages en 200 sans
  redirection ; `/access` toujours servi ;
- inscription **fermée** : note de fermeture dans le guide, aucun lien
  d'inscription dans les pieds de page, liens d'aide sur l'écran
  « Inscription désactivée ».

Écarts corrigés pendant la recette (dans le test, pas dans l'application) :
sur ordinateur, la dernière section ne peut pas remonter en haut (fin de
page) ; sur mobile, le sélecteur visait le lien masqué de la barre bureau.
Correction visuelle de l'application : numéros du sommaire alignés en haut
sur les intitulés de deux lignes.

Contrastes : palette 1-16B (calculée alors) ; nouveaux textes en
`#26364d` / `#3d4e66` sur blanc ou `#f5f8fc` (≥ 7,5:1).

Non relancés, conformément à la consigne : campagnes temps réel, paiement
(D.2H), suites API. **API non modifiée** : aucun test API nécessaire.

Captures (`docs/architecture/phase-1-16c-captures/`) :
`mobile-mentions-legales`, `bureau-confidentialite`, `mobile-guide`,
`bureau-conditions-abonnement`, `mobile-contact`, `mobile-auth-register`
(page entière), `ferme-mobile-auth-register`, `ferme-bureau-guide`.

## 8. Limites et points à revoir avant publication

1. **Aucun texte n'est publiable en l'état comme définitif** : identité
   absente, validation juridique absente, acceptation non enregistrée.
   Ils sont affichés comme projets et ne sont pas indexés.
2. Les pages sont accessibles publiquement dès un déploiement : décider si
   les projets doivent être en ligne avant validation.
3. Version anglaise non produite (décision § 6.2-5).
4. Le pied de page affiche « Inscription » seulement si le flag web est
   ouvert ; l'ouverture réelle reste liée aux deux flags (web et API).
5. Hors ligne : les nouvelles pages ne sont pas mises en cache par le
   service worker, qui n'a pas été modifié ; l'entrée « Aide » est désactivée
   hors connexion.
6. La page Connexion n'a toujours pas de `<h1>` (préexistant, hors
   périmètre).
7. Les faits techniques décrits valent pour le code au commit `12f8dc5` et
   ce lot : toute évolution (paiement, export, suppression, push) impose de
   mettre à jour les textes et `site-identity.ts`.

## 9. Mise à jour 1-16C.1 (7 octobre 2026)

Le lot 1-16C.1 ([rapport](phase-1-16c1-organization-support.md)) a modifié
ces pages ; les sections ci-dessus décrivent l'état d'origine.

- **Coordonnées confirmées** par le propriétaire et centralisées dans
  `site-identity.ts` : nom légal et commercial « Stock Master »,
  exploitant « entreprise », domaine, deux implantations (Douala, Yaoundé)
  sans siège désigné. Les quatre adresses sont **déclarées** fonctionnelles
  et **non testées** par l'équipe technique.
- **Avertissements retirés à la demande du propriétaire.** Les
  marqueurs « À compléter » et le bandeau « Projet » ne sont plus affichés.
  Chaque information manquante figure en commentaire dans le code
  (`{/* À COMPLÉTER : … */}`), au même endroit, sans valeur inventée. Les
  phrases qui n'avaient de sens qu'avec l'information absente ont été
  retirées. Les pages sont déployables en l'état.
- **Statut conservé** : les six documents juridiques restent « projet »
  dans le registre (version 0.2) et **non indexés**. Les renseignements et
  décisions des § 6.1 à 6.3 restent nécessaires, sauf l'identité de base
  désormais fournie ; le téléphone et le RCCM/NIU sont annoncés pour plus
  tard.
- **Assistance** : nouvelle page Organisation → Assistance ; Contact,
  Guide, Confidentialité, accord de traitement et conditions mis à jour en
  conséquence.
- Recette des pages relancée avec la nouvelle attente (ni bandeau, ni
  marqueur, `noindex`) : **49/49**, 0 marqueur visible.

## 10. État Git final

Branche `architecture/phase-1-16c-legal-and-usage-pages`, HEAD `12f8dc5`,
index vide, `stash@{0}` inchangé. Détail dans le compte rendu de fin de lot.
