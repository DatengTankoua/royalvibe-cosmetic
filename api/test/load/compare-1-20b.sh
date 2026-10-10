#!/usr/bin/env bash
# 1-20B — Comparaison ciblée avant/après du dispatcher (commandes exactes).
#
# Prérequis : pnpm --filter api build (nouveau code dans api/dist) et un
# témoin de l'ancien code dans api/.load-dist-1-20a-baseline (dist identique,
# dispatcher de HEAD transpilé ; voir le rapport 1-20B). Ports 4300/4398/4399
# libres ; aucune autre stack de charge en cours.
#
# Usage : K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20b.sh <groupe> <variante>
#   groupe   : sales | products-fairness | mixed
#   variante : baseline (ancien dispatcher) | new (nouveau dispatcher) |
#              new-lanes1 (nouveau, une seule voie : expérience)
set -euo pipefail
: "${K6:?K6 = chemin du binaire k6}"
: "${OUT:?OUT = dossier de résultats}"
cd "$(dirname "$0")/../../.."
GROUP="${1:?groupe}"
VARIANT="${2:?variante}"
STATE="$(node -e "console.log(require('os').tmpdir().split(String.fromCharCode(92)).join('/'))")/stockmaster-load-1-20a"
DIR="$OUT/$GROUP-$VARIANT"
mkdir -p "$DIR"
case "$VARIANT" in
  baseline) DIST_OPT="--dist=api/.load-dist-1-20a-baseline" ;;
  new) DIST_OPT="" ;;
  new-lanes1) DIST_OPT=""; export LOAD_DISPATCH_LANES=1 ;;
  *) echo "variante inconnue" >&2; exit 2 ;;
esac

# Stack neuve : mêmes données déterministes, file vide.
node api/test/load/load-stack.js start --profile=current --keep-state $DIST_OPT > "$DIR/stack.log" 2>&1 &
STACK_PID=$!
until grep -q "PRÊTE\|ÉCHEC" "$DIR/stack.log" 2>/dev/null; do sleep 2; done
grep -q "PRÊTE" "$DIR/stack.log"
node -e "const s=require('$STATE/state.json');console.log('dist',s.dist,'lanes',process.env.LOAD_DISPATCH_LANES||'défaut','free MB',Math.round(require('os').freemem()/2**20))" | tee "$DIR/conditions.txt"

RUN="node api/test/load/run-campaign.js --k6=$K6 --out=$DIR"
START_ISO=$(node -e "console.log(new Date().toISOString())")
case "$GROUP" in
  sales)
    $RUN --label=sales --scenario=sales --levels=5,10,25,50 --duration=45 ;;
  products-fairness)
    node api/test/load/quiet-org-probe.js --org=std2 --every-s=5 --duration=200 --timeout-s=240 --out="$DIR/quiet-org.json" > /dev/null &
    PROBE=$!
    $RUN --label=products-conc1 --scenario=products --target=org:conc1 --levels=5,10,25,50 --duration=45 || true
    wait $PROBE ;;
  mixed)
    $RUN --label=mixed --scenario=mixed --think --levels=25 --duration=120 --no-stop ;;
esac
END_ISO=$(node -e "console.log(new Date().toISOString())")
node api/test/load/integrity.js --since="$START_ISO" --wait-drain=300 --out="$DIR/integrity.json" > /dev/null || true
node api/test/load/notification-delays.js --from="$START_ISO" --to="$END_ISO" --out="$DIR/delays.json" > /dev/null
cp "$STATE"/metrics-db.jsonl "$STATE"/metrics-api.jsonl "$STATE"/metrics-proc.jsonl "$DIR/" 2>/dev/null || true
node api/test/load/load-stack.js stop > /dev/null
wait $STACK_PID || true
rm -rf "$STATE"
echo "terminé : $DIR"
