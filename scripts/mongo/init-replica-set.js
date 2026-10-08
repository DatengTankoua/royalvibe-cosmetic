// Phase 0B.7C — Initialisation IDEMPOTENTE du replica set mono-nœud « rs0 ».
//
// Exécuté par le service Compose « mono-shot » mongo-rs-init (image mongo:7,
// mongosh) contre l'instance de DEV locale. Comportement garanti :
//   0. la CONNEXION INITIALE (mongosh connecte l'hôte AVANT d'exécuter ce
//      script : un refus ne serait jamais intercepté par ce code) est
//      protégée par le healthcheck du service mongo dans docker-compose.yml
//      — mongo-rs-init a depends_on mongo avec condition: service_healthy.
//      Sans cette garde, la première exécution sortait en ECONNREFUSED
//      avant que le script ne soit chargé (incident de première activation).
//   1. APRÈS le démarrage de mongosh, une erreur transitoire de db.hello()
//      (oscillation de réplication, micro-indisponibilité) → on attend
//      jusqu'à une limite de temps bornée ;
//   2. la replica set est déjà configurée → on attend son état PRIMARY puis
//      on exit 0, SANS jamais ré-initier (aucun risque de réinitialisation) ;
//   3. la replica set n'est PAS encore configurée (volume vierge au premier
//      démarrage) → rs.initiate() appelé EXACTEMENT UNE FOIS ;
//   4. attente de l'état PRIMARY avec une limite de temps bornée ;
//   5. exit non nul (1) en cas d'échec réel — le conteneur reste Exited (1),
//      pas de redémarrage (restart: "no") ;
//   6. aucune donnée métier n'est créée ni modifiée.
//
// Un redémarrage de la stack ne réinitialise ni ne détruit rien : la
// configuration du replica set persiste dans le volume mongo_data et ce script
// la détecte puis ne fait rien.
//
// Note : sur un volume vierge, `db.hello().isWritablePrimary` est FAUX avant
// rs.initiate() (état normal pré-initiation) ; il ne devient vrai qu'APRÈS.
// L'initialisation ne conditionne donc PAS sur isWritablePrimary.

const REPLICA_SET = 'rs0';
const TIMEOUT_MS = 90000;

function fail(message) {
  print('mongo-rs-init ERREUR: ' + message);
  exit(1);
}

const deadline = Date.now() + TIMEOUT_MS;

// 1. Re-lecture transitoire : mongosh est JÀ connecté lors de l'exécution de
//    ce script (la toute première connexion de mongosh est protégée par le
//    healthcheck de docker-compose.yml, depends_on: service_healthy).
//    db.hello() peut néanmoins échouer de manière transitoire après coup
//    (oscillation de réplication) : on re-sonde jusqu'au délai.
let hello;
for (;;) {
  try {
    hello = db.hello();
    break;
  } catch (err) {
    if (Date.now() > deadline) {
      fail("MongoDB n'a pas accepté de connexion avant le délai" +
        (err ? " — " + String(err) : ''));
    }
    print('mongo-rs-init: MongoDB injoignable, on attend…');
    sleep(500);
  }
}

// Nom de replica set inattendu → échec explicite (jamais de confusion).
if (hello.setName && hello.setName !== REPLICA_SET) {
  fail(`nom de replica set inattendu « ${hello.setName} » (attendu « ${REPLICA_SET} »)`);
}

// 2/3. rs.initiate() UNIQUEMENT si la configuration est absente.
if (!hello.setName) {
  try {
    // Membre déclaré sous l'alias de service Docker « mongo » : résolvable sur
    // le réseau du projet, et stable après redémarrage du conteneur.
    rs.initiate({
      _id: REPLICA_SET,
      members: [{ _id: 0, host: 'mongo:27017' }],
    });
    print(`mongo-rs-init: replica set « ${REPLICA_SET} » initiée — attente du PRIMARY`);
  } catch (err) {
    fail('rs.initiate() a échoué : ' + String(err));
  }
} else {
  print(`mongo-rs-init: replica set « ${REPLICA_SET} » déjà configurée — rien à faire`);
}

// 4. Attente (bornée) que le nœud soit le PRIMARY de « rs0 ».
for (;;) {
  try {
    hello = db.hello();
  } catch (err) {
    hello = null; // oscillation de réplication : on re-sonde
  }
  if (hello && hello.setName === REPLICA_SET && hello.isWritablePrimary) {
    print(`mongo-rs-init: « ${REPLICA_SET} » opérationnel (isWritablePrimary=true) — exit 0`);
    exit(0);
  }
  if (Date.now() > deadline) {
    fail(`le nœud n'est pas devenu PRIMARY de « ${REPLICA_SET} » avant le délai`);
  }
  sleep(500);
}
