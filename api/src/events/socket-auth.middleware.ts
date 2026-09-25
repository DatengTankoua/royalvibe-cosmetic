import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'http';
import type { Server, Socket } from 'socket.io';
import { UsersService } from '../users/users.service';
import {
  OrganizationsService,
  type ResolvedOrganizationContext,
} from '../organizations/organizations.service';
import { OriginAllowlist } from './origin.helpers';

/**
 * Contrôle authentifié des connexions Socket.IO — phase 0B.3.
 *
 * Deux couches, vérifiées contre la version installée (socket.io 4.8.3 /
 * engine.io 6.6.9 / @nestjs/websockets 11.1.28) :
 *
 * 1. `installSocketAuthMiddleware` — middleware Socket.IO (`io.use`),
 *    exécuté UNE seule fois par connexion, AVANT l'établissement du
 *    namespace (`Namespace.run` → packet `CONNECT_ERROR` au client si
 *    refus). Le token ne provient QUE de `socket.handshake.auth.token`.
 *
 * 2. `createAllowRequest` — l'option engine.io `allowRequest`, supportée
 *    par les types de cette version et lue par `Server#verify` pour
 *    CHAQUE requête handshake ET upgrade de transport : le transport
 *    **WebSocket** est donc aussi couvert (l'option `cors` seule ne
 *    porte que le long-polling). Égalité EXACTE sur l'allowlist.
 *
 * 3. **Vérification du champ `exp` au handshake** — le payload vérifié
 *    DOIT porter `exp` (secondes epoch, number fini) dans le FUTUR strict
 *    (`exp > Date.now()/1000`) :
 *    - `exp` absent → refus `unauthorized` ;
 *    - `exp` non-number (string, null, NaN, Infinity, …) → refus `unauthorized` ;
 *    - `exp` ≤ maintenant (déjà expiré) → refus `unauthorized`.
 *    Aucun de ces cas ne crée de timer ni n'appelle `socket.disconnect`
 *    : le refus passe par `next(Error('unauthorized'))` (garde `done`,
 *    exactement une fois) et le namespace Socket.IO n'est PAS établi.
 *
 * 4. **Déconnexion à l'expiration du JWT** — `scheduleSocketDisconnectAtExpiry` :
 *    après validation complète (dont l'étape 3), le socket reste
 *    connecté jusqu'à l'épuisement du JWT : le middleware programme alors
 *    `socket.disconnect(true)` à `exp` (timestamp du payload vérifié,
 *    secondes epoch) via un timer `unref()` (ne bloque PAS la fin du
 *    process) nettoyé sur `disconnect` (pas de fuite ni de double appel).
 *
 * Confidentialité : aucune journalisation du JWT ni du payload. Toute
 * erreur d'authentification renvoie le message client **générique et
 * unique** `'unauthorized'` — le client ne distingue jamais token
 * expiré, falsifié ou lié à un user supprimé.
 */

/**
 * Clé unique du token dans `socket.handshake.auth`. Aucune autre clé ni
 * source (query string, headers, userId/role client) n'est consultée.
 */
export const SOCKET_AUTH_TOKEN_KEY = 'token';

// ObjectId canonique : une CHAÎNE strictement de 24 caractères hexadécimaux.
// Aucune forme non-canonique n'est acceptée (nombre, objet, chaîne vide,
// 12/24 caractères non-hex) — la validation rejette AVANT toute requête DB.
// `isValidObjectId()` n'est PAS utilisé (cast trop permissif).
const isStrictObjectId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

/**
 * Principal attaché à `socket.data.user` : `sub`/`orgId` issus du JWT
 * vérifié ; `email`/`role` lus EXCLUSIVEMENT du document User chargé de la
 * base (les claims éventuels du token sont ignorés). Base de l'isolation
 * par rooms à venir (`organization:{orgId}`).
 */
export interface SocketPrincipal {
  sub: string;
  orgId: string;
  email: string;
  role: string;
}

/** Dépendances injectées (mêmes instances que l'auth HTTP). */
export interface SocketAuthDependencies {
  jwtService: JwtService;
  usersService: UsersService;
  organizationsService: OrganizationsService;
  logger?: Logger;
}

/** Type du callback `next` du middleware Socket.IO. */
export type SocketMiddlewareNext = (err?: Error) => void;

/**
 * Installe le middleware d'authentification du handshake sur `server`
 * (UNE fonction `io.use` par appel). Retourne le middleware installé pour
 * inspection directe en test.
 *
 * Garanties codifiées (tests unitaires + E2E) :
 * - token lu UNIQUEMENT dans `socket.handshake.auth.token` ;
 * - vérification signature + expiration via `JwtService.verifyAsync`
 *   (MÊME instance/secret que l'auth HTTP — AuthModule, `JWT_SECRET`) ;
 * - re-vérification de l'existence de l'utilisateur via
 *   `UsersService.findById` (MÊME politique que `JwtStrategy.validate`) ;
 * - principal = `sub`/`orgId` du JWT vérifié + `email`/`role` du document
 *   User de la base (les claims `email`/`role` du token sont ignorés) ;
 * - `next()` (sans erreur) appelé EXACTEMENT UNE FOIS, uniquement quand le
 *   principal est attaché dans `socket.data.user` ; en cas de refus,
 *   `next(err)` appelé EXACTEMENT UNE FOIS (garde interne `done`) ;
 * - `socket.data.user` ne contient QUE `sub`, `orgId`, `email`, `role`
 *   — jamais `password`, le token, ni un document Mongoose complet ;
 * - le payload vérifié porte `{ sub, orgId }` + `exp` (number fini) futur :
 *   `exp` absent, non-number, NaN, Infinity ou déjà dépassé
 *   (`exp <= Date.now()/1000`) → **refus au handshake**
 *   `next(Error('unauthorized'))` exactement une fois, **aucun timer
 *   créé, `socket.disconnect` jamais appelé, namespace non établi** ;
 * - après acceptation, `socket.disconnect(true)` est programmé à `exp`
 *   via `scheduleSocketDisconnectAtExpiry` (timer `unref()`, nettoyé sur
 *   `disconnect`) — jamais appelé dans un chemin de refus.
 */
export function installSocketAuthMiddleware(
  server: Server,
  deps: SocketAuthDependencies,
): (socket: Socket, next: SocketMiddlewareNext) => void {
  const { jwtService, usersService, organizationsService } = deps;
  const logger = deps.logger ?? new Logger('EventsGateway');

  const middleware = (socket: Socket, next: SocketMiddlewareNext): void => {
    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      next(err);
    };

    void (async () => {
      try {
        // 1. Token présent, non vide, et lu UNIQUEMENT dans
        //    `socket.handshake.auth.token` (aucune autre source).
        //    L'objet `auth` du handshake est toujours un objet (Socket.IO
        //    normalise l'absent vers `{}`) : pas de dépendance au
        //    comportement de version.
        const auth = socket.handshake.auth as Record<string, unknown>;
        const token = auth[SOCKET_AUTH_TOKEN_KEY];
        if (typeof token !== 'string' || token.length === 0) {
          logger.warn(
            'Socket.IO: connection rejected — missing handshake auth token',
          );
          finish(new Error('unauthorized'));
          return;
        }

        // 2 + 3. Vérification signature + expiration (MÊME configuration
        //    que l'auth HTTP : instance du JwtModule du AuthModule) +
        //    structure minimale du payload ({ sub, orgId }).
        // `Record<string, unknown>` (et non le `any` par défaut du
        // générique `JwtService.verifyAsync<T = any>`) : le reste du
        // payload (dont `exp`, §timer) reste typé inconnu.
        const payload =
          await jwtService.verifyAsync<Record<string, unknown>>(token);
        const sub: unknown = payload?.sub;
        const orgId: unknown = payload?.orgId;
        // STRICT : string + 24 hex (jamais de cast). Une valeur non canonique
        // (nombre, objet, chaîne vide, 12/24 caractères non-hex) est refusée
        // AVANT toute requête DB et AVANT l'attachement du principal.
        if (!isStrictObjectId(sub) || !isStrictObjectId(orgId)) {
          logger.warn(
            'Socket.IO: connection rejected — JWT payload missing required fields',
          );
          finish(new Error('unauthorized'));
          return;
        }

        // 4. Champ `exp` du PAYLOAD VÉRIFIÉ : DOIT être un number fini dans
        //    le futur strict (`exp > Date.now()/1000`). Refus si : absent,
        //    non-number, NaN, Infinity, ou `exp` déjà dépassé. Le refus passe
        //    par la garde `done` (`next(err)` EXACTEMENT une fois) AVANT toute
        //    création de timer / `socket.disconnect` / établissement du
        //    namespace → la garantie « aucun timer, pas de déconnexion,
        //    connexion non établie » est portée par le `return` ci-dessous.
        const exp: unknown = payload?.exp;
        if (
          typeof exp !== 'number' ||
          !Number.isFinite(exp) ||
          exp <= Date.now() / 1000
        ) {
          logger.warn(
            'Socket.IO: connection rejected — JWT missing/invalid/expired `exp`',
          );
          finish(new Error('unauthorized'));
          return;
        }

        // 5. L'utilisateur existe encore (idempotent `JwtStrategy.validate` :
        //    `usersService.findById(sub)`).
        const user = await usersService.findById(sub);
        if (!user) {
          logger.warn(
            'Socket.IO: connection rejected — JWT sub no longer resolves to a user',
          );
          finish(new Error('unauthorized'));
          return;
        }

        const organizationContext =
          await organizationsService.resolveActiveContext(sub, orgId);

        // 5 + 6. Principal dans `socket.data.user` — JAMAIS de `password`,
        //    du token ou du document Mongoose complet. `email`/`role` sont
        //    lus du document User (base) JAMAIS du token ; `orgId` vient du
        //    JWT vérifié (future isolation par rooms `organization:{id}`).
        socket.data.user = {
          sub: user._id.toString(),
          orgId: organizationContext.organizationId,
          email: user.email,
          role: user.role,
        } satisfies SocketPrincipal;
        socket.data.organizationContext =
          organizationContext satisfies ResolvedOrganizationContext;

        // 7. `next()` appelé EXACTEMENT UNE FOIS, sans erreur.
        finish();

        // 8. Le socket est alors établi par Socket.IO. On programme la
        //    déconnexion à l'expiration du token (payload vérifié, `exp` en
        //    secondes epoch). Silencieux si `exp` est absent/invalid —
        //    jamais une raison supplémentaire de rejet.
        scheduleSocketDisconnectAtExpiry(socket, payload, logger);
      } catch {
        // Toute autre erreur (signature invalide, token expiré, payload
        //    corrompu, …) : message client UNIFIÉ et générique. Le JWT
        //    n'est JAMAIS journalisé.
        logger.warn('Socket.IO: connection rejected — invalid or expired JWT');
        finish(new Error('unauthorized'));
      }
    })();
  };

  server.use(middleware);
  return middleware;
}

/**
 * Programme `socket.disconnect(true)` à l'expiration du JWT — la
 * vérification n'a lieu qu'au handshake (comportement standard de
 * Socket.IO), sans quoi un socket pourrait survivre jusqu'à 7 jours après
 * l'expiration du token.
 *
 * - `exp` = champ standard JWT (secondes epoch, entier) lu dans le
 *   **payload vérifié** (jamais un payload décodé non vérifié) ;
 * - `exp` absent / non-number / non fini → **aucun timer, aucun log,
 *   aucun rejet** (la connexion reste valable jusqu'à la prochaine
 *   vérification — cas ne se produisant pas avec le `JwtModule` courant,
 *   qui met toujours `exp`) ;
 * - `exp` déjà dépassé au handshake → timer au prochain tick (le token
 *   est alors techniquement expiré — la vérification l'aurait rejetée ;
 *   aucun rejet supplémentaire n'est ajouté ici) ;
 * - timer **`unref()`** : il ne maintient PAS le process (ni le run de
 *   Jest) ouvert ;
 * - timer **nettoyé sur `disconnect`** : aucune fuite, aucun double
 *   appel après déconnexion client.
 *
 * Le timer est programmé APRÈS `finish()` du middleware : le socket n'est
 * établi que par `next()` — `socket.disconnect(true)` le force-ferme
 * côté serveur à l'échéance (l'événement `disconnect` arrive au client).
 *
 * Retourne le timer programmé (inspection directe en test ; sous fake
 * timers le shim sinonjs est structurellement identique : `refed`/
 * `hasRef`/`unref`) ou `undefined` quand aucun timer n'a été créé
 * (`exp` absent/invalid ou erreur).
 */
export function scheduleSocketDisconnectAtExpiry(
  socket: Socket,
  payload: Readonly<Record<string, unknown>>,
  logger?: Logger,
): NodeJS.Timeout | undefined {
  const exp: unknown = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return undefined;
  }
  try {
    // Attaché AVANT `setTimeout` : si le socket se déconnecte entre les
    // deux, le listener est déjà en place et nettoie le timer.
    const onDisconnect = (): void => clearTimeout(timer);
    socket.once('disconnect', onDisconnect);
    const delayMs = Math.max(exp * 1000 - Date.now(), 0);
    const timer = setTimeout(() => {
      socket.off('disconnect', onDisconnect);
      socket.disconnect(true);
    }, delayMs);
    timer.unref?.(); // Node : unref(); le shim fake timers expose aussi `unref`.
    return timer;
  } catch {
    logger?.error('Socket.IO: could not schedule disconnect at token expiry');
    return undefined;
  }
}

/**
 * Fabrique la fonction `allowRequest` engine.io (option supportée par les
 * types installés) :
 * - lit l'en-tête `Origin` (Node normalise en minuscule :
 *   `req.headers.origin`) — Host/Referer ne sont JAMAIS consultés ;
 * - compare par ÉGALITÉ EXACTE à l'allowlist (pas de sous-domaine, pas de
 *   `endsWith`, pas de wildcard) ;
 * - origine inconnue → `fn('forbidden origin', false)` ;
 * - `Origin` absent → refus en production ; toléré en dev/test pour les
 *   clients Node sans en-tête navigateur (comportement documenté dans le
 *   rapport 0B.3) ;
 * - aucune journalisation des en-têtes reçus.
 */
export function createAllowRequest(
  allowlist: OriginAllowlist,
  environment: 'production' | 'development' | 'test',
): (
  req: IncomingMessage,
  fn: (err: string | null, success: boolean) => void,
) => void {
  return (req, fn) => {
    const header: unknown = req.headers?.origin;
    const origin = Array.isArray(header) ? header[0] : header;
    if (typeof origin !== 'string' || origin.length === 0) {
      if (environment === 'production') {
        fn('forbidden origin', false);
      } else {
        fn(null, true);
      }
      return;
    }
    const allowed = allowlist.isAllowed(origin);
    fn(allowed ? null : 'forbidden origin', allowed);
  };
}
