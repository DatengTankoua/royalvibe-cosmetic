#!/usr/bin/env bash
# 1-20D — Relectures du catalogue après les ventes, avant/après.
#
# Prérequis : pnpm --filter api build (nouveau code dans api/dist) ; témoin
# de l'état 1-20C (1-20B compris) :
#   node api/test/load/make-baseline-dist.js --ref=<révision 1-20C> \
#     --files=src/products/products.controller.ts,src/products/products.service.ts
# Ports 4300/4398/4399 libres ; aucune autre charge.
#
# Usage : OUT=<dossier> bash api/test/load/compare-1-20d.sh <clients> <variante>
#   variante : baseline (API 1-20C, web 1-20C simulé : `legacy`)
#            | new (API 1-20D, web 1-20D simulé : `targeted`)
set -euo pipefail
: "${OUT:?OUT = dossier de résultats}"
cd "$(dirname "$0")/../../.."
CLIENTS="${1:?clients}"
VARIANT="${2:?variante}"
STATE="$(node -e "console.log(require('os').tmpdir().split(String.fromCharCode(92)).join('/'))")/stockmaster-load-1-20a"
DIR="$OUT/refresh-$CLIENTS-$VARIANT"
mkdir -p "$DIR"
case "$VARIANT" in
  baseline) DIST_OPT="--dist=api/.load-dist-1-20a-baseline"; MODE=legacy ;;
  new) DIST_OPT=""; MODE=targeted ;;
  *) echo "variante inconnue" >&2; exit 2 ;;
esac

# Stack neuve : mêmes données, file de notifications vide ; démarrage borné.
start_stack() {
  node api/test/load/load-stack.js start --profile=current --keep-state $DIST_OPT > "$DIR/stack.log" 2>&1 &
  STACK_PID=$!
  while ! grep -q "PRÊTE" "$DIR/stack.log" 2>/dev/null; do
    kill -0 "$STACK_PID" 2>/dev/null || return 1
    sleep 2
  done
}
if ! start_stack; then
  cp "$DIR/stack.log" "$DIR/stack-attempt1.log"
  rm -rf "$STATE"
  start_stack || { echo "démarrage impossible : $DIR/stack.log" >&2; exit 1; }
fi
node -e "const s=require('$STATE/state.json');console.log('dist',s.dist,'mode $MODE','free MB',Math.round(require('os').freemem()/2**20))" | tee "$DIR/conditions.txt"

# 30 s de ventes à 2/s ; fin bornée (≤ 15 s de repos) dans la sonde.
timeout 300 node api/test/load/catalog-refresh-probe.js --mode="$MODE" \
  --clients="$CLIENTS" --sales-per-s=2 --duration=30 --out="$DIR/probe.json" > /dev/null
node api/test/load/integrity.js --wait-drain=120 --out="$DIR/integrity.json" > /dev/null || true
node api/test/load/load-stack.js stop > /dev/null
wait $STACK_PID || true
rm -rf "$STATE"
echo "terminé : $DIR"
