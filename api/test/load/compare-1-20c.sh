#!/usr/bin/env bash
# 1-20C — Catalogue avant/après la réutilisation des URL signées.
#
# Prérequis : pnpm --filter api build (nouveau code dans api/dist) ; témoin
# de l'état AVANT 1-20C (1-20B compris) :
#   node api/test/load/make-baseline-dist.js --ref=HEAD --files=src/s3/s3.service.ts
# Ports 4300/4398/4399 libres ; aucune autre charge.
#
# Usage : K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20c.sh <profil> <variante>
#   profil   : current (catalogue standard : froid 1 VU 15 s, puis 1, 5, 10 VU)
#              | large (catalogue volumineux : froid 1 VU 15 s, puis 1 VU)
#   variante : baseline (avant 1-20C) | new
set -euo pipefail
: "${K6:?K6 = chemin du binaire k6}"
: "${OUT:?OUT = dossier de résultats}"
cd "$(dirname "$0")/../../.."
PROFILE="${1:?profil}"
VARIANT="${2:?variante}"
STATE="$(node -e "console.log(require('os').tmpdir().split(String.fromCharCode(92)).join('/'))")/stockmaster-load-1-20a"
DIR="$OUT/catalog-$PROFILE-$VARIANT"
mkdir -p "$DIR"
case "$VARIANT" in
  baseline) DIST_OPT="--dist=api/.load-dist-1-20a-baseline" ;;
  new) DIST_OPT="" ;;
  *) echo "variante inconnue" >&2; exit 2 ;;
esac
case "$PROFILE" in
  current) WARM_LEVELS="1,5,10" ;;
  large) WARM_LEVELS="1" ;;
  *) echo "profil inconnu" >&2; exit 2 ;;
esac

# Stack neuve : cache vide, mêmes données, file de notifications vide.
# Démarrage : attend « PRÊTE » ou la fin du lanceur (jamais d'attente
# infinie) ; un second essai si le premier échoue (démarrage lent).
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
node -e "const s=require('$STATE/state.json');console.log('dist',s.dist,'profil',s.profile,'free MB',Math.round(require('os').freemem()/2**20))" | tee "$DIR/conditions.txt"

RUN="node api/test/load/run-campaign.js --k6=$K6 --out=$DIR --scenario=catalog --no-stop"
# Démarrage à cache froid : premières lectures après le démarrage de l'API.
$RUN --label=cold --levels=1 --duration=15
# Fonctionnement à cache chaud (fenêtre de réutilisation : 300 s).
$RUN --label=warm --levels="$WARM_LEVELS" --duration=45
cp "$STATE"/metrics-api.jsonl "$STATE"/metrics-db.jsonl "$DIR/" 2>/dev/null || true
node api/test/load/load-stack.js stop > /dev/null
wait $STACK_PID || true
rm -rf "$STATE"
echo "terminé : $DIR"
