import {
  MongoMemoryReplSet,
  MongoMemoryReplSetOpts,
} from 'mongodb-memory-server';

/**
 * E2E infrastructure (phase 0B.2) — MongoDB éphémère totalement isolée.
 *
 * Règles de sécurité durcies dans ce module :
 * - le replica set n'écoute QUE sur l'adresse locale (127.0.0.1) ;
 * - la base porte toujours le nom explicite E2E_DB_NAME ;
 * - `assertEphemeralUri` REFUSE, de façon fatale, toute URI qui pointe sur
 *   le port 27017 (MongoDB de développement), une adresse distante, ou une
 *   base autre que E2E_DB_NAME ;
 * - l'instance est portée par un singleton de module : avantAll (qui démarre)
 *   et aprèsAll (qui arrête) du spec partagent la MÊME instance sans variable
 *   globale — c'est aussi pourquoi on n'utilise PAS globalSetup/globalTeardown
 *   (leur contexte mémoire est disjoint de celui du spec) ;
 * - aucun secret n'est journalisé (l'URI n'expose que host/port/nom de base).
 */

export const E2E_DB_NAME = 'inventory_saas_e2e';

// Version DU BINAIRE MongoDB utilisée par l'infrastructure de test.
// Test-only : définie ici uniquement, JAMAIS lue depuis un .env ni depuis
// la configuration de production. Pin explicite pour que la suite E2E soit
// reproductible indépendamment de la version par défaut de la librairie
// mongodb-memory-server (qui peut changer à sa propre mise à jour).
// Vérifié contre les types réels de mongodb-memory-server@11.2.0 :
// MongoMemoryReplSetOpts.binary (MongoBinaryOpts extends
// BaseDryMongoBinaryOptions) expose exactement `version?: string` — c'est la
// clé utilisée (et non .create(), absent de l'API réelle : le constructeur
// `new MongoMemoryReplSet(opts)` est l'entrée de fait).
export const E2E_MONGODB_BINARY_VERSION = '8.2.6';

// URI de développement de référence (issue de .env.example, jamais lue à
// l'exécution) : sert de référence à la garde « URI normale de développement ».
const DEV_URI_REFERENCE = 'mongodb://localhost:27017/heyama';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEV_MONGODB_PORT = 27017;

let singleton: MongoMemoryReplSet | null = null;

function options(): MongoMemoryReplSetOpts {
  return {
    binary: {
      // Version du binaire mongod explicite (ne pas laisser la version par
      // défaut de la librairie décider — reproductibilité E2E).
      version: E2E_MONGODB_BINARY_VERSION,
    },
    replSet: {
      count: 1,
      dbName: E2E_DB_NAME,
      storageEngine: 'wiredTiger',
    },
  };
}

/**
 * Démarre le replica set éphémère (1 membre, wiredTiger, base nommée)
 * AVANT toute initialisation d'AppModule. Idempotent : un second appel
 * renvoie l'instance déjà démarrée (un seul mongod par process).
 */
export async function startEphemeralMongo(): Promise<MongoMemoryReplSet> {
  if (singleton) return singleton;
  const replSet = new MongoMemoryReplSet(options());
  await replSet.start();
  singleton = replSet;
  return replSet;
}

/**
 * Instance partagée par la suite E2E (démarret dans beforeAll, arrêt dans
 * afterAll — voir app.e2e-spec.ts).
 */
export function getEphemeralMongo(): MongoMemoryReplSet | null {
  return singleton;
}

/**
 * URI MongoDB à donner à AppModule, VALIDÉE par la garde. getUri(E2E_DB_NAME)
 * porte le path de la base (le getUri() brut ne contient que host:port et
 * replicaSet — vérifié empiriquement). Ne lève que si l'URI n'est pas celle
 * de l'instance éphémère (garde fatale).
 */
export function validatedEphemeralUri(replSet: MongoMemoryReplSet): string {
  return assertEphemeralUri(replSet.getUri(E2E_DB_NAME));
}

/**
 * Arrête le replica set et SUPPRIME toutes ses données, même après un échec
 * (le spec l'appelle systématiquement dans aprèsAll — try/finally).
 * doCleanup:true + force:true supprime le dossier de données temporaire
 * (force : le dossier ne garantie pas d'être sous os.tmpdir()).
 * Idempotent : n'arrête que si une instance existe.
 */
export async function stopEphemeralMongoSafe(): Promise<void> {
  if (!singleton) return;
  const replSet = singleton;
  singleton = null;
  try {
    await replSet.stop({ doCleanup: true, force: true });
  } catch {
    // Un échec de stop (mongod déjà mort) ne doit pas masquer l'erreur
    // d'origine du test : on avale seulement l'erreur de teardown.
  }
}

/**
 * Garde d'isolation : valide qu'une URI MongoDB est bien l'instance éphémère
 * locale produite par ce test (adresse 127.0.0.1, port aléatoire, base nommée).
 * Lève une erreur (test fatal) si l'une de ces conditions est vraie :
 * - l'URI correspond à l'URI de développement de référence ;
 * - le host n'est pas une adresse locale (pas d'URI distante) ;
 * - le port est 27017 (MongoDB de développement) ;
 * - la base n'est pas E2E_DB_NAME ;
 * - l'URI contient des identifiants ;
 * - l'URI n'est pas parsable.
 * Retourne l'URI validée (celle produite par l'instance éphémère).
 */
export function assertEphemeralUri(uri: string): string {
  if (uri === DEV_URI_REFERENCE) {
    throw new Error(
      'E2E refused: URI is the dev MongoDB URI (mongodb://localhost:27017/heyama).',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`E2E refused: unparsable MongoDB URI: ${uri}`);
  }
  if (parsed.protocol !== 'mongodb:') {
    throw new Error(`E2E refused: unexpected protocol ${parsed.protocol}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('E2E refused: URI carries credentials (unexpected).');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `E2E refused: host "${parsed.hostname}" is not a local address.`,
    );
  }
  const port = Number(parsed.port);
  if (port === DEV_MONGODB_PORT) {
    throw new Error(
      'E2E refused: port 27017 is the dev MongoDB port. Tests must never use it.',
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`E2E refused: invalid port "${parsed.port}".`);
  }
  const expectedPath = `/${E2E_DB_NAME}`;
  if (parsed.pathname !== expectedPath) {
    throw new Error(
      `E2E refused: database "${parsed.pathname}" is not the ephemeral "${expectedPath}".`,
    );
  }
  return uri;
}
