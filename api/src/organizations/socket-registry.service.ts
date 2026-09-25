import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

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
  disconnectMember(organizationId: string, userId: string): void {
    const key = this.key(organizationId, userId);
    const existing = this.sockets.get(key);
    if (!existing) return;
    for (const socket of existing) socket.disconnect(true);
    this.sockets.delete(key);
  }
}
