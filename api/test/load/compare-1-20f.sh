#!/usr/bin/env bash
# 1-20F — Ouverture d'un rayon avant/après la pagination serveur des produits.
#
# Prérequis : pnpm --filter api build (nouveau code dans api/dist) ; témoin
# de l'état 1-20E :
#   node api/test/load/make-baseline-dist.js --ref=<révision 1-20E> \
#     --files=src/products/products.controller.ts,src/products/products.service.ts,src/migrations/predeploy-migrations.ts
# Ports 4300/4398/4399 libres ; aucune autre charge.
#
# Usage : K6=<k6.exe> OUT=<dossier> bash api/test/load/compare-1-20f.sh <profil> <variante>
#   profil   : current (froid 1 VU 15 s, puis 1 et 10 VU 45 s, rôles mélangés)
#            | large (froid 1 VU 15 s, puis 1 VU 45 s ; propriétaire de
#              l'entreprise concentrée : rayons les plus grands)
#   variante : baseline (API 1-20E, web 1-20E : rayon complet)
#            | new (API 1-20F, web 1-20F : page, suivante, recherche,
#              synchronisation hors ligne mesurée à part)
#            | legacy-on-new (API 1-20F, ancien web : anciens onglets)
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
  baseline) DIST_OPT="--dist=api/.load-dist-1-20a-baseline"; export CATALOG_MODE=legacy ;;
  new) DIST_OPT=""; export CATALOG_MODE=paged ;;
  legacy-on-new) DIST_OPT=""; export CATALOG_MODE=legacy ;;
  *) echo "variante inconnue" >&2; exit 2 ;;
esac
case "$PROFILE" in
  current) WARM="1,10" ;;
  large) WARM="1"; export TARGET=concentrated ROLES=owner ;;
  # Scénario complémentaire : profil `large` + un rayon de 2 000 produits
  # (propriétaire de l'entreprise concentrée, ce seul rayon).
  bigsection) WARM="1"; export TARGET=concentrated ROLES=owner SECTION=big LOAD_BIG_SECTION=2000 ;;
  *) echo "profil inconnu" >&2; exit 2 ;;
esac

start_stack() {
  node api/test/load/load-stack.js start --profile="${PROFILE/bigsection/large}" --keep-state $DIST_OPT > "$DIR/stack.log" 2>&1 &
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
node -e "const s=require('$STATE/state.json');console.log('dist',s.dist,'mode $CATALOG_MODE','free MB',Math.round(require('os').freemem()/2**20))" | tee "$DIR/conditions.txt"

# Nouveau web face à l'ancienne API : la requête paginée reçoit-elle le
# tableau complet (repli `legacy`) ?
if [ "$VARIANT" = baseline ]; then
  node api/test/load/compat-probe.js --out="$DIR/compat-old-api.json" > /dev/null
fi

RUN="node api/test/load/run-campaign.js --k6=$K6 --out=$DIR --scenario=catalogpage --target=${TARGET:-multi} --no-stop"
# Démarrage à cache froid (signatures), puis fonctionnement à cache chaud.
$RUN --label=cold --levels=1 --duration=15
$RUN --label=warm --levels="$WARM" --duration=45
node api/test/load/products-page-explain.js --synthetic=5000 --out="$DIR/explain.json" > /dev/null || true
cp "$STATE"/metrics-api.jsonl "$STATE"/metrics-db.jsonl "$DIR/" 2>/dev/null || true
node api/test/load/load-stack.js stop > /dev/null
wait $STACK_PID || true
rm -rf "$STATE"
echo "terminé : $DIR"
