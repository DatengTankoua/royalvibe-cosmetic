# Preuves du lot 1-20A (référence de charge)

Copie durable des résultats de [phase-1-20a-load-baseline.md](../phase-1-20a-load-baseline.md),
utilisée comme point de comparaison par 1-20B. Les fichiers d'origine
étaient dans un répertoire temporaire de session.

Contenu vérifié avant copie : **aucun jeton, aucune session, aucune
adresse e-mail** (comptes fictifs `@charge.local` absents), chemins locaux
remplacés par `<résultats>/` ou `<local>`. Les identifiants MongoDB
(ObjectId) présents sont ceux de bases éphémères supprimées.

| Dossier | Contenu |
|---|---|
| `tiers/` | Synthèses par palier de `run-campaign.js` (débit offert/obtenu, latences par route, API, MongoDB, processus, verdict des critères d'arrêt) |
| `tiers-table.md` | Tableau rendu par `render-results.js` |
| `k6/` | Synthèses k6 brutes des paliers comparés en 1-20B : ventes, produits (et témoins à 1 VU), série mixte retenue (stack 4) |
| `checks/` | Intégrité (stacks 1 à 4), concurrence sous charge, délais du dispatcher par palier (`delays-*.json`), sondes temps réel |
| `series/` | Séries brutes compressées (`metrics-db`, `metrics-api`, toutes les 1 à 2 s) des stacks 1 et 4, fenêtres des phases de la stack 1, synthèse texte du profil CPU du catalogue (le `.cpuprofile` brut, 0,8 Mo et chemins locaux, n'est pas conservé) |
| `mixed-v1-not-retained/` | Première série mixte (stack 2), écartée dans le rapport (aucun vendeur aux petits paliers) |

Lire une série : `zcat series/stack1-metrics-db.jsonl.gz | head`.
