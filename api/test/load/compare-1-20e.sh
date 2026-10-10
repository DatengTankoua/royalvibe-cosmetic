#!/usr/bin/env bash
# 1-20E — Page Ventes avant/après la pagination serveur.
#
# Prérequis : pnpm --filter api build (nouveau code dans api/dist) ; témoin
# de l'état 1-20D :
#   node api/test/load/make-baseline-dist.js --ref=<révision 1-20D> \
#     --files=src/sales/sales.controller.ts,src/sales/sales.service.ts,src/migrations/predeploy-migrations.ts
# Ports 4300/4398/4399 libres ; aucune autre charge.
#
# Usage : K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20e.sh <profil> <variante>
#   profil   : current (1 puis 5 VU) | large (1 VU)
#   variante : baseline (API 1-20D, page 1-20D : `GET /sales` complet)
#            | new (API 1-20E, page 1-20E : `GET /sales/history`)
#            | legacy-on-new (API 1-20E, ancien contrat `GET /sales` conservé :
#              coût des anciens onglets après déploiement)
#   profil large : historique de 30 000 ventes (propriétaire de l'entreprise
#   concentrée, `TARGET=concentrated ROLES=owner`).
set -euo pipefail
: "${K6:?K6 = chemin du binaire k6}"
: "${OUT:?OUT = dossier de résultats}"
cd "$(dirname "$0")/../../.."
PROFILE="${1:?profil}"
VARIANT="${2:?variante}"
STATE="$(node -e "console.log(require('os').tmpdir().split(String.fromCharCode(92)).join('/'))")/stockmaster-load-1-20a"
DIR="$OUT/sales-$PROFILE-$VARIANT"
mkdir -p "$DIR"
case "$VARIANT" in
  baseline) DIST_OPT="--dist=api/.load-dist-1-20a-baseline"; export SALES_MODE=legacy ;;
  new) DIST_OPT=""; export SALES_MODE=paged ;;
  legacy-on-new) DIST_OPT=""; export SALES_MODE=legacy ;;
  *) echo "variante inconnue" >&2; exit 2 ;;
esac
case "$PROFILE" in
  current) LEVELS="1,5"; FAR=25 ;;
  large) LEVELS="1"; FAR=50; export TARGET=concentrated ROLES=owner ;;
  *) echo "profil inconnu" >&2; exit 2 ;;
esac

start_stack() {
  node api/test/load/load-stack.js start --profile="$PROFILE" --keep-state $DIST_OPT > "$DIR/stack.log" 2>&1 &
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
node -e "const s=require('$STATE/state.json');console.log('dist',s.dist,'mode $SALES_MODE','free MB',Math.round(require('os').freemem()/2**20))" | tee "$DIR/conditions.txt"

RUN="node api/test/load/run-campaign.js --k6=$K6 --out=$DIR --scenario=salespage --target=${TARGET:-multi} --no-stop"
$RUN --label=page --levels="$LEVELS" --duration=45
# Page éloignée (curseur), nouveau contrat seulement : 1 VU.
if [ "$VARIANT" = new ]; then
  FAR_PAGES=$FAR $RUN --label=far --levels=1 --duration=30 --pace=5
fi
FAR_DEPTH=1000 node api/test/load/sales-history-explain.js --out="$DIR/explain.json" > /dev/null
FAR_DEPTH=25000 node api/test/load/sales-history-explain.js --out="$DIR/explain-deep.json" > /dev/null || true
cp "$STATE"/metrics-api.jsonl "$STATE"/metrics-db.jsonl "$DIR/" 2>/dev/null || true
node api/test/load/load-stack.js stop > /dev/null
wait $STACK_PID || true
rm -rf "$STATE"
echo "terminé : $DIR"
