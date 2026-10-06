import { Injectable, Logger } from '@nestjs/common';

/** Émetteur branché par `EventsGateway.afterInit` (même contrat qu'1-15F). */
export interface NotificationSignalEmitter {
  toMember(
    organizationId: string,
    userId: string,
    event: string,
    payload: unknown,
  ): void;
}

export const NOTIFICATIONS_CHANGED = 'notifications:changed';

/**
 * 1-16A.1 — Signal PRIVÉ `notifications:changed` (`{}`) aux seuls sockets du
 * destinataire dans la room de son organisation (couverture valide) : création
 * d'une notification, lecture, « tout marquer comme lu », préférences. Les
 * autres appareils relisent alors compteur et liste par l'API (coordinateur
 * 1-15A). Best effort, jamais d'exception ; sans passerelle (CLI, tests sans
 * socket) : aucun effet.
 */
@Injectable()
export class NotificationSignalsService {
  private readonly logger = new Logger(NotificationSignalsService.name);
  private emitter: NotificationSignalEmitter | null = null;

  attachEmitter(emitter: NotificationSignalEmitter): void {
    this.emitter = emitter;
  }

  changed(organizationId: string, userId: string): void {
    const emitter = this.emitter;
    if (!emitter) return;
    try {
      emitter.toMember(organizationId, userId, NOTIFICATIONS_CHANGED, {});
    } catch {
      this.logger.warn(`${NOTIFICATIONS_CHANGED} non émis (best effort).`);
    }
  }
}
