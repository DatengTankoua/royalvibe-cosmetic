import { Injectable, Logger } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import type { Server, Socket } from 'socket.io';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { SocketRegistryService } from '../organizations/socket-registry.service';
import {
  buildOriginAllowlist,
  parseCORSOrigin,
  type OriginAllowlist,
  type OriginEnvironment,
} from './origin.helpers';
import {
  createAllowRequest,
  installSocketAuthMiddleware,
} from './socket-auth.middleware';

/**
 * Gateway Socket.IO — phase 0B.3 : authentification du handshake + contrôle
 * des origines.
 *
 * Deux verrous complémentaires, vérifiés contre la version installée
 * (socket.io 4.8.3 / engine.io 6.6.9 / @nestjs/websockets 11.1.28) :
 *
 * 1. **Authentification du handshake** — middleware Socket.IO `io.use`
 *    (exécuté une fois par connexion, AVANT l'établissement du namespace)
 *    installé dans `afterInit` sur le serveur Socket.IO réel :
 *    - le token ne provient QUE de `socket.handshake.auth.token` ;
 *    - vérification signature + expiration via le MÊME `JwtService` que
 *      l'auth HTTP (secret `JWT_SECRET`) ;
 *    - re-vérification de l'existence du `user` (`JwtStrategy.validate`) ;
 *    - principal minimal `socket.data.user = { sub, email, role }` ;
 *    - refus → erreur client générique `unauthorized` + `connect_error`.
 *
 * 2. **Contrôle des origines** — double mécanisme, installé UNE fois via les
 *    options du décorateur `@WebSocketGateway` (transmises au constructeur
 *    Socket.IO → IoAdapter → engine.io). Chaque option est une **function
 *    lue par requête** (relis `process.env.CORS_ORIGIN`) : le reload env en
 *    dev ET les valeurs de test en E2E sont respectés sans jamais
 *    figer une allowlist au boot :
 *    - `cors.origin` (délegate function) : long-polling — réfléchit l'`Origin`
 *      exacte autorisée, AUCUN `*` ; une origine non autorisée ne reçoit
 *      aucun en-tête d'autorisation ;
 *    - `allowRequest` (engine.io) : lu par `Server#verify` pour CHAQUE
 *      handshake ET upgrade de transport → couvre aussi le transport
 *      **WebSocket** (l'option `cors` seule ne porte que le long-polling).
 *      Égalité EXACTE sur l'allowlist `CORS_ORIGIN` ; `Origin` absent →
 *      refus en production, toléré en dev/test (documenté).
 *
 * `main.ts` (CORS HTTP) est volontairement NON modifié en 0B.3 : le helper
 * `origin.helpers` est conçu pour être réutilisé à la phase 0B.4.
 *
 * Diffusion : après cette phase, seuls les utilisateurs authentifiés
 * reçoivent les événements. Les événements restent diffusés à TOUS les
 * utilisateurs authentifiés de l'unique entreprise actuelle — insuffisant
 * après l'arrivée d'un 2ᵉ tenant (rooms `organization:{id}` à la phase
 * multi-tenant). Voir rapport 0B.3.
 *
 * Durée de connexion : le JWT courant dure 7 jours (`JwtModule`). La
 * vérification du token n'a lieu qu'au handshake (comportement standard de
 * Socket.IO) ; le socket ne survit PAS à l'expiration du token : le
 * middleware programme `socket.disconnect(true)` à `exp`
 * (`scheduleSocketDisconnectAtExpiry`, timer `unref()` nettoyé sur
 * `disconnect`) : le socket est donc fermé de force par le serveur à
 * l'échéance du token, même si la connexion est restée ouverte.
 */

/** Environnement courant, lu à la volée (dev/test vs prod). */
function resolveEnvironment(): OriginEnvironment {
  return process.env.NODE_ENV === 'production' ? 'production' : 'development';
}

/** Résout l'allowlist + environnement pour une requête donnée. */
function resolveForRequest(): {
  allowlist: OriginAllowlist;
  environment: OriginEnvironment;
} {
  const environment = resolveEnvironment();
  const allowlist = buildOriginAllowlist(
    parseCORSOrigin(process.env.CORS_ORIGIN, environment),
  );
  return { allowlist, environment };
}

/**
 * `cors.origin` delegate (package `cors`, long-polling). Motif standard :
 * renvoie `true` (réfléchit l'en-tête `Origin` exacte de la requête) si
 * l'origine est autorisée, `false` sinon (aucun en-tête d'autorisation).
 * Jamais de wildcard. Une config invalide → refus (pas de bypass).
 */
const corsOriginDelegate: (
  origin: string | undefined | null,
  callback: (err: null, reflect: boolean) => void,
) => void = (origin, callback) => {
  try {
    const { allowlist } = resolveForRequest();
    callback(null, allowlist.isAllowed(origin ?? null));
  } catch {
    callback(null, false);
  }
};

/**
 * `allowRequest` engine.io : gate réel pour le handshake ET l'upgrade
 * websocket. Égalité exacte sur l'allowlist ; `Origin` absent → refus en
 * production, toléré en dev/test. Aucune journalisation des en-têtes.
 */
const allowRequestForSocket: (
  req: { headers: IncomingHttpHeaders },
  fn: (err: string | null, success: boolean) => void,
) => void = (req, fn) => {
  try {
    const { allowlist, environment } = resolveForRequest();
    createAllowRequest(allowlist, environment)(
      req as unknown as IncomingMessage,
      fn,
    );
  } catch {
    fn('forbidden origin', false);
  }
};

export const organizationRoom = (organizationId: string): string =>
  `organization:${organizationId}`;

@Injectable()
@WebSocketGateway({
  // Options transmises au constructeur Socket.IO (voir
  // @nestjs/platform-socket.io IoAdapter → new Server(httpServer, options)).
  // `cors` pilote le package `cors` de engine.io (long-polling) ;
  // `allowRequest` est lu par `Server#verify` (handshake + upgrade).
  cors: {
    origin: corsOriginDelegate,
  },
  allowRequest: allowRequestForSocket,
})
export class EventsGateway {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly socketRegistry: SocketRegistryService,
  ) {}

  /**
   * Hook d'initialisation — le serveur Socket.IO `server` est fourni par
   * NestJS et `this.server` est déjà assigné à ce moment. On installe le
   * middleware d'auth du handshake UNE fois sur ce serveur.
   *
   * **Production** : avant l'installation, la garde production exige
   * `CORS_ORIGIN` obligatoire et valide — sinon `parseCORSOrigin` lève →
   * le bootstrap de l'application échoue avant toute connexion (pas de
   * valeur par défaut ouverte). En dev/test, les fallbacks limités
   * (`LOCAL_DEV_ORIGINS`) s'appliquent — documentés dans origin.helpers.
   */
  afterInit(server: Server): void {
    if (process.env.NODE_ENV === 'production') {
      // Garde production : lève si CORS_ORIGIN absente ou invalide.
      parseCORSOrigin(process.env.CORS_ORIGIN, 'production');
    }
    installSocketAuthMiddleware(server, {
      jwtService: this.jwtService,
      usersService: this.usersService,
      organizationsService: this.organizationsService,
      logger: new Logger(EventsGateway.name),
    });
  }

  handleConnection(client: Socket): void {
    const organizationContext = client.data.organizationContext as
      { organizationId?: string; userId?: string } | undefined;
    const organizationId = organizationContext?.organizationId;
    const userId = organizationContext?.userId;
    if (!organizationId || !userId) {
      client.disconnect(true);
      return;
    }
    void client.join(organizationRoom(organizationId));
    // 1-7C : registre en mémoire — permet de déconnecter ce membre après
    // une mutation de membership (suspension/révocation/transfert).
    this.socketRegistry.register(organizationId, userId, client);
  }

  handleDisconnect(client: Socket): void {
    const organizationContext = client.data.organizationContext as
      { organizationId?: string; userId?: string } | undefined;
    const organizationId = organizationContext?.organizationId;
    const userId = organizationContext?.userId;
    if (!organizationId || !userId) return;
    this.socketRegistry.unregister(organizationId, userId, client);
  }

  emitToOrganization(
    organizationId: string,
    event: string,
    payload: unknown,
  ): void {
    this.server.to(organizationRoom(organizationId)).emit(event, payload);
  }
}
