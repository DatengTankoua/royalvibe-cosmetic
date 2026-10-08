# Recette locale des paiements (1-14D.2H)

Stack **strictement locale** et relançable pour éprouver à la main (ou par la
campagne Playwright) le parcours de paiement d'abonnement, le webhook et le
rapprochement. Tout est fictif : comptes, secrets, clé webhook, identifiants
et transactions CamPay. **Aucun appel CamPay réel, aucun `.env` lu, aucune
base autre que l'instance éphémère créée par le lanceur.**

> Cette recette ne valide **ni** la compatibilité avec CamPay **ni** le
> comportement derrière Railway. Le faux CamPay reprend les formes
> documentées (D.2D, D.2F) ; il ne prouve rien du service réel.

Rapport et résultats : [phase-1-14d2h-payment-local-recipe.md](../../../docs/architecture/phase-1-14d2h-payment-local-recipe.md).

## Prérequis

- Node 22 et les dépendances déjà installées (`pnpm install` fait une fois ;
  rien n'est installé par la recette).
- API compilée : `pnpm --filter api build`.
- Ports libres sur `127.0.0.1` : 3200 (web), 4200 (API), 4299 (contrôle).
  Un port occupé fait échouer le démarrage ; aucun processus n'est arrêté.
- Le build et le serveur web tournent dans une **copie isolée**,
  `.stockmaster-recipe-web/` à la racine du dépôt. Elle ne contient que les
  sources nécessaires (`src`, `public`, fichiers de configuration) et
  **aucun `.env*`** : ces fichiers sont écartés sur leur nom, sans jamais être
  ouverts. Son `node_modules` est une jonction vers `web/node_modules`.
  `web/` et `web/.next` ne sont jamais touchés.
- Ce dossier apparaît dans `git status` pendant la recette, et il ne faut
  pas l'ajouter à un commit. Il doit être sous la racine du dépôt (Turbopack
  refuse un `node_modules` hors de sa racine) et **non ignoré** par Git
  (Tailwind n'analyse pas les chemins ignorés). Il est supprimé à l'arrêt, ou
  au démarrage suivant après un arrêt brutal.
- Le build télécharge les polices Geist (`next/font/google`), comme tout
  build web du projet.

Toutes les commandes se lancent depuis la racine du dépôt.

## 1. Démarrer

Terminal 1 (reste au premier plan) :

```bash
node api/test/recipe/recipe.js start                    # fournisseur simulé (contrat D.2C)
node api/test/recipe/recipe.js start --provider=campay  # vrai adaptateur CamPay sur faux CamPay local
# option : --keep-logs (journaux conservés après l'arrêt)
```

Le lanceur affiche les URLs, le mot de passe et les comptes, puis attend.
Ordre : copie isolée et build web (environ 30 s, refaits à chaque
démarrage) → `MongoMemoryReplSet` (127.0.0.1, port aléatoire) →
4 migrations → fixtures → simulateurs → API → web.

## 2. Ouvrir le web et se connecter

Ouvrir `http://127.0.0.1:3200/auth/login` (utiliser exactement `127.0.0.1`,
seule origine autorisée par le CORS de l'API). Mot de passe commun :
`Recette-locale-14d2h!`. Téléphone de paiement fictif : `677123456`.

| Compte | Rôle | Usage |
|---|---|---|
| `proprietaire.actif@recette.local` | owner | Paiement depuis `/app` → Organisation → Abonnement |
| `admin.actif@recette.local` | admin | Aucun panneau de paiement (« réservée au propriétaire ») |
| `vendeur.actif@recette.local` | seller | Idem |
| `proprietaire.limite@recette.local` | owner, expiré | Session limitée `/access` : paiement puis récupération de l'accès |
| `vendeur.limite@recette.local` | seller, expiré | « Contactez le propriétaire », aucun panneau |
| `proprietaire.webhook@recette.local` | owner, expiré | Webhook (mode `campay`) |
| `proprietaire.rapprochement@recette.local` | owner | Initiation incertaine puis rapprochement (mode `campay`) |
| `proprietaire.revue@recette.local` | owner | `review` puis rapprochement (mode `campay`) |
| `proprietaire.suspendu@recette.local` | owner, expiré | Suspension prioritaire |

Un compte ne peut avoir qu'un paiement ouvert : pour rejouer un parcours,
créer un propriétaire neuf : `recipe.js owner --label=essai2 [--expired]`.

## 3. Piloter (terminal 2)

`R="node api/test/recipe/recipe.js"` ; `$R help` liste tout.

| Commande | Effet |
|---|---|
| `$R status` | Fournisseur, URLs, PID, santé de l'API |
| `$R provider simulated\|campay` | Redémarre l'API avec ce fournisseur (base conservée) |
| `$R restart-api` | Remet à zéro les compteurs de limitation (mémoire) |
| `$R payments [--email=<e>]` | Paiements, périodes `payment`, audits de rapprochement |
| `$R sim stats` / `sim transactions` / `sim reset` | Collectes, consultations, transactions simulées |
| `$R sim settle --reference=<réf> --state=succeeded\|failed\|pending` | Le payeur valide ou refuse (référence marchand affichée, ou référence prestataire) |
| `$R sim queue-init lost\|reject\|unavailable\|uncertain-not-created\|accept` | Comportement de la prochaine collecte |
| `$R sim queue-status override:amount=2999\|unavailable\|not-found` | Comportement de la prochaine consultation |
| `$R expire --email=<e>` / `$R org suspend\|reactivate --email=<e>` | Écritures de test explicites |

### Parcours (fournisseur `simulated`)

- **En attente → vérification → succès** : payer ; noter la référence
  affichée (`SM…`) ; `$R sim settle --reference=SM… --state=succeeded` ;
  cliquer « Vérifier le paiement ». En session limitée, l'échange
  `complete` ramène sur `/app`.
- **Réponse perdue** : dans les outils de développement, couper le réseau
  pendant le clic « Payer », puis recharger : le paiement est retrouvé sans
  seconde collecte (`$R sim stats` : une initiation).
- **Échec puis nouvel essai** : `settle --state=failed`, « Vérifier », puis
  « Nouvel essai » (action explicite, nouvelle collecte).
- **`uncertain`** : `$R sim queue-init lost` puis payer.
  **`review`** : payer, `settle --state=succeeded`,
  `$R sim queue-status override:amount=2999`, « Vérifier ».
- **Suspension prioritaire** : avec `proprietaire.suspendu`, payer sur
  `/access`, `$R org suspend --email=…`, `settle`, « Vérifier » : « Accès
  refusé », aucun échange.
- **Outbox** : enregistrer une vente hors ligne, laisser expirer
  (`$R expire`), payer depuis l'écran de blocage : la vente reste seule dans
  l'outbox puis se synchronise après le succès.

### Webhook (fournisseur `campay`)

```bash
$R provider campay
# payer avec proprietaire.webhook (session limitée) ; puis :
$R payments --email=proprietaire.webhook@recette.local    # paymentId, providerReference
$R webhook --payment-id=<id> --wrong-key                    # 401
$R webhook --payment-id=<id>                                 # 200, statut relu PENDING : rien
$R sim settle --reference=<providerReference> --state=succeeded
$R webhook --payment-id=<id>                                 # 200 : succeeded, 1 période
$R webhook --replay                                          # 200 : toujours 1 période
```

La notification est un POST JSON de forme officielle, signé HS256 avec la
**clé fictive** de la recette. Le webhook n'est activé que par l'entrée de
test `boot-api.js` en mode `campay` ; en mode `simulated` (et en
production), il répond 503 `PAYMENT_WEBHOOK_DISABLED`.

### Rapprochement (fournisseur `campay`)

```bash
$R sim queue-init lost      # puis payer avec proprietaire.rapprochement : « Résultat à vérifier »
$R payments --email=proprietaire.rapprochement@recette.local   # paymentId, providerReference null
$R sim transactions                                              # référence CamPay (relevé opérateur)
$R sim settle --reference=<uuid> --state=succeeded
$R reconcile-sim inspect   --payment-id=<id>                     # code 0
$R real-cli      reconcile --payment-id=<id> --reference=<uuid>  # VRAI CLI : code 4, provider-unavailable
$R reconcile-sim reconcile --payment-id=<id> --reference=<uuid>  # simulation : plan, aucune écriture
$R reconcile-sim reconcile --payment-id=<id> --reference=<uuid> --apply --plan=<planToken> \
   --operation-id=<uuid v4> --operator=recette --reason=uncertain-initiation   # applied
# même commande, même --operation-id : replayed, aucune nouvelle période ni consultation
$R payments --email=proprietaire.rapprochement@recette.local     # 1 période, 1 audit
```

- `reconcile-sim` est une **entrée de test séparée** : parseur, couche de
  commande et service D.2G compilés, fournisseur CamPay injecté vers le
  faux CamPay local. Chaque exécution l'annonce sur la sortie d'erreur.
- `real-cli` lance le **vrai** binaire (`subscription:reconcile-payment`)
  sur la base de recette : sans aucune surcharge, il reste bloqué par
  `UnavailablePaymentProvider` (seule l'inspection fonctionne).

## 4. Campagne navigateur

Playwright n'est pas une dépendance du dépôt : indiquer une installation
existante (et un Chromium existant si sa révision diffère).

```bash
$R scenarios --playwright=<dossier contenant node_modules/playwright> \
   [--chromium=<chrome.exe>] [--out=<dossier de résultats>] [ids...]
```

Sans Playwright ou Chromium disponibles, la commande répond « AUCUNE
campagne exécutée » (code 3). Les scénarios redémarrent l'API et changent
de fournisseur eux-mêmes ; lancer la campagne sur une stack dédiée.

### Notifications push (1-16A)

L'API de recette active les notifications avec une paire VAPID **fictive**
(`push-vapid.json` du répertoire d'état) et un transport **simulé** : chaque
message est consigné dans `push.jsonl`, aucun service push n'est contacté.

```bash
$R push-browser --playwright=<dir> [--chromium=<exe>] [--out=<dir>] [P1..P6]
```

La page reçoit un abonnement navigateur fictif ; le message consigné est
livré au service worker existant par le protocole DevTools
(`ServiceWorker.deliverPushMessage`). L'API est redémarrée avant chaque
scénario (limiteur de connexion en mémoire).

## 5. Consulter et nettoyer

- Résultats de campagne : `results.json` et captures dans `--out`
  (conservés).
- Journaux de la stack : `%TEMP%/stockmaster-recipe-14d2h/logs` (supprimés
  à l'arrêt, sauf `--keep-logs`).
- Arrêt : Ctrl+C dans le terminal 1, ou `$R stop`. Le lanceur arrête
  **ses** processus (et leurs descendants), l'instance MongoDB (données
  supprimées) et efface son répertoire d'état. Après un arrêt brutal du
  lanceur, l'API et le web s'arrêtent seuls (chien de garde). La copie
  `.stockmaster-recipe-web/` est supprimée au démarrage suivant, et le
  dossier de données `%TEMP%/mongo-mem-*` de cette instance peut rester.

## 6. Contrôles d'isolement `.env`

```bash
$R env-guard-selftest                 # garde JavaScript : canaris, témoin sans garde
$R web-canary-check [--out=<f.json>]  # vrai next build + next start avec canaris (≈ 3 min)
```

`web-canary-check` utilise le port 3299 et des dossiers temporaires
`.stockmaster-recipe-canary/`, supprimés ensuite. Il construit et sert
quatre copies des sources, avec des `.env*` **fictifs** et une page et une
route de sonde :

- T1, témoin : le chargement **doit** être détecté ;
- T2, garde seule ;
- T3, copie isolée (configuration du lanceur) ;
- T4, copie isolée sans autre protection.

La commande sort en code 0 si les quatre cas sont conformes.
