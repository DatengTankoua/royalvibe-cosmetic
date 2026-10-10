# Campagnes de charge locales (1-20A, 1-20B, 1-20C)

Outils de mesure de charge **strictement locaux** de Stock Master. Rapports :
[phase-1-20a-load-baseline.md](../../../docs/architecture/phase-1-20a-load-baseline.md)
(référence) et
[phase-1-20b-notification-throughput.md](../../../docs/architecture/phase-1-20b-notification-throughput.md)
(débit du dispatcher, avant/après) et
[phase-1-20c-product-image-signing.md](../../../docs/architecture/phase-1-20c-product-image-signing.md)
(signatures d'URL des photos, avant/après).

> Aucune cible distante : toute URL non locale (ou port ≠ 4300) et toute base
> autre que l'instance éphémère `stockmaster_load` sont refusées. Aucun appel
> à Railway, Vercel, MongoDB réel, Cloudflare, Resend, stockage ou service
> push réel.

## Outils

| Fichier                  | Rôle                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `load-stack.js`          | Stack : MongoDB éphémère (replica set, cache borné), 9 migrations de pré-déploiement, peuplement, stockage simulé, API compilée, échantillonneurs |
| `load-api.js`            | Entrée de test de l'API (réplique `main.ts`) : e-mail et push simulés, mesures internes, profil CPU à la demande                                  |
| `load-seed.js`           | Jeu déterministe (profils `current`, `large`) et sessions préparées                                                                               |
| `k6/stockmaster.js`      | Parcours HTTP (Grafana k6) : `catalog`, `dashboard`, `sales`, `products`, `notifications`, `mixed`                                                |
| `run-campaign.js`        | Paliers, agrégation des mesures, critères d'arrêt fixés                                                                                           |
| `realtime-probe.js`      | Socket.IO (client `socket.io-client`, mesuré à part de k6)                                                                                        |
| `concurrency.js`         | Intégrité sous concurrence (stock, annulations, rejeu, adhésions, 429)                                                                            |
| `integrity.js`           | Invariants en lecture seule (stock, audit, notifications, vidange)                                                                                |
| `notification-delays.js` | Délais du dispatcher (outbox, centre, regroupement volontaire, retard push) sur une fenêtre                                                       |
| `render-results.js`      | Tableaux Markdown des résultats                                                                                                                   |
| `profile-summary.js`     | Synthèse d'un `.cpuprofile`                                                                                                                       |
| `campaign-1-20a.sh`      | Commandes exactes de la campagne 1-20A                                                                                                            |
| `compare-1-20b.sh`       | 1-20B : un groupe (`sales`, `products-fairness`, `mixed`) sur une stack neuve, ancien (`baseline`) ou nouveau (`new`) dispatcher                  |
| `compare-summary.js`     | 1-20B : synthèse avant/après (paliers, file, délais, vidange, intégrité, entreprise peu active, réponses inattendues)                             |
| `quiet-org-probe.js`     | 1-20B : entreprise peu active pendant la charge d'une autre (délai vu par l'utilisateur)                                                          |
| `make-baseline-dist.js`  | 1-20B : témoin `api/.load-dist-1-20a-baseline` (dist identique, dispatcher d'une révision donnée)                                                 |
| `compare-1-20c.sh`       | 1-20C : catalogue (`current` : froid puis 1, 5, 10 VU ; `large` : froid puis 1 VU) sur une stack neuve, avant (`baseline`) ou après (`new`)       |

## Prérequis

- Node 22, dépendances installées, `pnpm --filter api build`.
- k6 : binaire officiel (`k6-v2.3.0-windows-amd64.zip`, SHA-256 vérifié
  contre `k6-v2.3.0-checksums.txt`), hors dépôt. Rien n'est installé par
  ces outils.
- Ports libres sur 127.0.0.1 : 4300 (API), 4398 (stockage simulé), 4399
  (contrôle).

## Utilisation

```bash
# Terminal 1 (premier plan)
node api/test/load/load-stack.js start --profile=current --keep-state

# Terminal 2
K6=<k6.exe> OUT=<dossier> bash api/test/load/campaign-1-20a.sh baseline
K6=<k6.exe> OUT=<dossier> bash api/test/load/campaign-1-20a.sh ramps
K6=<k6.exe> OUT=<dossier> bash api/test/load/campaign-1-20a.sh integrity
node api/test/load/load-stack.js stop
```

Comparaison 1-20B (stack lancée par le script, une par groupe et variante) :

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=<révision de l'ancien dispatcher>
for g in sales products-fairness mixed; do
  for v in baseline new; do
    K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20b.sh $g $v
  done
done
node api/test/load/compare-summary.js <dossier>
rm -rf api/.load-dist-1-20a-baseline
```

Comparaison 1-20C :

```bash
pnpm --filter api build
node api/test/load/make-baseline-dist.js --ref=<révision> --files=src/s3/s3.service.ts
for p in current large; do
  for v in baseline new; do
    K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20c.sh $p $v
  done
done
node api/test/load/compare-summary.js <dossier>
rm -rf api/.load-dist-1-20a-baseline
```

Les signatures d'URL réellement calculées sont comptées par l'entrée de
test (intergiciel sur le client de signature, `metrics-api.jsonl`,
champ `signatures`), identiquement pour les deux variantes.

Options de k6 : `TARGET=org:<clé>` concentre la charge sur une entreprise.
Toute réponse inattendue est journalisée (`UNEXPECTED {json}` : route,
statut, code, erreur k6, identifiant de corrélation `x-load-correlation-id`)
et regroupée par le pilote dans `<palier>.unexpected.jsonl`. Critère d'arrêt
ajouté : plus ancien travail de notification prêt > 120 s.

Réglages d'expérience de l'entrée de test (jamais en production) :
`--dist=<dossier sous api/>`, `LOAD_DISPATCH_LANES=<n>`,
`LOAD_KEEPALIVE_MS=<ms>`.

Profil CPU : écrire `{"seconds":20,"label":"x"}` dans
`%TEMP%/stockmaster-load-1-20a/cpu-profile.request` pendant la charge, puis
`node api/test/load/profile-summary.js %TEMP%/stockmaster-load-1-20a/x.cpuprofile`.

## Nettoyage

`stop` (ou Ctrl+C) arrête les seuls processus lancés, l'instance MongoDB
(données supprimées) et efface `%TEMP%/stockmaster-load-1-20a` (sauf
`--keep-state` : supprimer ce dossier à la main ensuite). Supprimer aussi le
témoin `api/.load-dist-1-20a-baseline` après une comparaison.
