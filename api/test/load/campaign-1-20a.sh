#!/usr/bin/env bash
# 1-20A — Campagne de référence (commandes exactes du rapport).
#
# Prérequis : pnpm --filter api build ; k6 (binaire officiel, somme SHA-256
# vérifiée) ; ports 127.0.0.1:4300/4398/4399 libres. Stack lancée à part :
#   node api/test/load/load-stack.js start --profile=current --keep-state
#
# Usage : K6=<k6.exe> OUT=<dossier de résultats> bash api/test/load/campaign-1-20a.sh <étape>
# Étapes : baseline | ramps | fine | realtime | mixed | steady | spike | concurrency | large
set -euo pipefail
: "${K6:?K6 = chemin du binaire k6}"
: "${OUT:?OUT = dossier de résultats}"
cd "$(dirname "$0")/../../.."
RUN="node api/test/load/run-campaign.js --k6=$K6 --out=$OUT"
STATE="${TMPDIR:-${TEMP:-/tmp}}/stockmaster-load-1-20a"

case "${1:-}" in
  baseline) # très faible charge : 1 VU, 20 s par parcours
    for sc in catalog dashboard sales products notifications; do
      $RUN --label=baseline-$sc --scenario=$sc --levels=1 --duration=20 --no-stop
    done ;;
  ramps) # paliers 5/10/25/50 VU, 45 s, rythme 1 itération/s/VU, arrêt au 1er seuil
    for sc in catalog dashboard sales products notifications; do
      $RUN --label=ramp-$sc --scenario=$sc --levels=5,10,25,50 --duration=45
    done ;;
  fine) # paliers intermédiaires quand le 1er palier franchit déjà un seuil
    $RUN --label=ramp-dashboard-fine --scenario=dashboard --levels=2,3,4 --duration=45
    $RUN --label=ramp-catalog-fine --scenario=catalog --levels=6,7,8 --duration=45 ;;
  concentrated) # une entreprise, plusieurs vendeurs
    $RUN --label=conc-sales --scenario=sales --target=concentrated --levels=5,12,25 --duration=45
    $RUN --label=conc-catalog --scenario=catalog --target=concentrated --levels=2,5,10 --duration=45 ;;
  realtime) # Socket.IO (client compatible), mesuré séparément de k6
    for k in 1 3 5; do
      extra=""; [ "$k" = 5 ] && extra="--reconnect"
      node api/test/load/load-stack.js mark rt-$k
      node api/test/load/realtime-probe.js --sockets-per-user=$k --sales-per-s=2 --duration=30 --refetch $extra --out="$OUT/realtime-$k.json"
      node api/test/load/load-stack.js mark idle
    done ;;
  mixed) # mixte avec pauses réalistes (1 à 4 s entre actions)
    $RUN --label=mixed-ramp --scenario=mixed --think --levels=5,10,25,50 --duration=60 ;;
  steady) # charge stable + intégrité sous concurrence pendant la charge
    $RUN --label=mixed-steady --scenario=mixed --think --levels="${STEADY_VUS:-25}" --duration=180 --no-stop &
    sleep 60
    node api/test/load/concurrency.js --out="$OUT/concurrency-under-load.json"
    wait ;;
  spike) # pic court et borné puis retour à faible charge
    $RUN --label=mixed-spike --scenario=mixed --think --levels="${SPIKE_VUS:-75}" --duration=30 --no-stop
    $RUN --label=mixed-recovery --scenario=mixed --think --levels=5 --duration=60 --no-stop ;;
  integrity)
    node api/test/load/integrity.js --wait-drain="${DRAIN_S:-120}" --out="$OUT/integrity-$(date +%H%M%S).json" ;;
  large) # profil volumineux : redémarrer la stack avec --profile=large avant
    for sc in catalog dashboard; do
      $RUN --label=large-$sc --scenario=$sc --levels=1,2,5,10 --duration=45
    done
    $RUN --label=large-sales --scenario=sales --levels=5,10,25 --duration=45 ;;
  *)
    echo "étape inconnue : ${1:-}" >&2; exit 2 ;;
esac
