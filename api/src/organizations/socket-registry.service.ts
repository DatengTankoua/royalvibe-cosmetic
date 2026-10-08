import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';

/**
 * 1-15C — signaux d'organisation : invalidations SANS donnée (`{}`), qui
 * demandent seulement aux écrans autorisés de relire l'API.
 * - `members:changed` : droits, rôle, statut, transfert, nouveau membre ;
 * - `invitations:changed` : création, révocation, acceptation ;
 * - `organization:updated` : nom, couleur ou logo.
 */
export type OrganizationSignal =
  'members:changed' | 'invitations:changed' | 'organization:updated';

type OrganizationEmitter = (
  organizationId: string,
  event: string,
  payload: unknown,
) => void;

/**
 * 1-7C — registre en mémoire des sockets connectées, par organisation +
 * utilisateur. Exporté par `OrganizationsModule` (jamais l'inverse : ce
 * module ne dépend PAS d'`EventsModule`, qui l'importe déjà pour
 * `OrganizationsService` — `EventsGateway` et `OrganizationsService`
 * partagent ainsi la MÊME instance sans dépendance circulaire).
 *
 * Limite mono-instance : ce registre vit en mémoire du process Node —
 * un déploiement multi-instance (horizontal scaling) perdrait les sockets
 * connectées à une AUTRE instance. Un adaptateur Redis (`@socket.io/redis-adapter`)
 * + un canal pub/sub équivalent seraient requis avant tout déploiement
 * horizontal (documenté ici, non implémenté).
 */
@Injectable()
export class SocketRegistryService {
  private readonly sockets = new Map<string, Set<Socket>>();
  private readonly logger = new Logger(SocketRegistryService.name);
  private organizationEmitter: OrganizationEmitter | null = null;

  /**
   * 1-15C — branché par `EventsGateway.afterInit` : son `emitToOrganization`
   * (room `organization:<id>`, sockets à couverture d'abonnement valide
   * seulement). Ce registre est déjà le pont entre `OrganizationsService` et
   * la passerelle (même instance, sans dépendance circulaire de modules).
   */
  attachOrganizationEmitter(emitter: OrganizationEmitter): void {
    this.organizationEmitter = emitter;
  }

  /**
   * 1-15C — signal d'invalidation à l'organisation, APRÈS une écriture
   * validée (après commit le cas échéant). Payload vide : jamais de membre,
   * d'e-mail, de permission, de jeton ni d'URL. Best effort : une panne
   * d'émission ne transforme jamais l'écriture en erreur HTTP ; sans
   * passerelle (tests, démarrage), aucun effet.
   */
  signalOrganization(organizationId: string, event: OrganizationSignal): void {
    try {
      this.organizationEmitter?.(organizationId, event, {});
    } catch {
      this.logger.warn(`${event} non émis (best effort).`);
    }
  }

  private key(organizationId: string, userId: string): string {
    return `${organizationId}:${userId}`;
  }

  register(organizationId: string, userId: string, socket: Socket): void {
    const key = this.key(organizationId, userId);
    const existing = this.sockets.get(key);
    if (existing) {
      existing.add(socket);
      return;
    }
    this.sockets.set(key, new Set([socket]));
  }

  unregister(organizationId: string, userId: string, socket: Socket): void {
    const key = this.key(organizationId, userId);
    const existing = this.sockets.get(key);
    if (!existing) return;
    existing.delete(socket);
    if (existing.size === 0) this.sockets.delete(key);
  }

  /**
   * Déconnecte toutes les sockets connues de ce membre (jamais avant un
   * commit, jamais sur rollback — appelé UNIQUEMENT par le code appelant
   * après succès de la transaction). Une reconnexion recharge le contexte
   * (`organizationContext`) via le middleware d'auth du handshake.
   */
  /**
   * 1-13B — après une réinitialisation de mot de passe (écriture déjà
   * effectuée) : ferme, dans TOUTES les organisations de l'utilisateur, les
   * sockets dont la version de session du handshake est antérieure à
   * `currentVersion`. Les sockets portant déjà la nouvelle version restent
   * ouverts. Même limite mono-instance que le reste du registre.
   */
  disconnectUserSessionsBefore(userId: string, currentVersion: number): number {
    let closed = 0;
    for (const [key, sockets] of this.sockets) {
      if (!key.endsWith(`:${userId}`)) continue;
      for (const socket of [...sockets]) {
        const version: unknown = (socket.data as { authVersion?: unknown })
          ?.authVersion;
        const socketVersion = typeof version === 'number' ? version : 0;
        if (socketVersion >= currentVersion) continue;
        sockets.delete(socket);
        socket.disconnect(true);
        closed += 1;
      }
      if (sockets.size === 0) this.sockets.delete(key);
    }
    return closed;
  }

  disconnectMember(organizationId: string, userId: string): void {
    const key = this.key(organizationId, userId);
    const existing = this.sockets.get(key);
    if (!existing) return;
    for (const socket of existing) socket.disconnect(true);
    this.sockets.delete(key);
  }
}
