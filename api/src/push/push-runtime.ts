import { Injectable } from '@nestjs/common';
import type { EnabledWebPushConfig } from './push-config';
import type { PushTransport } from './push-transport';

/**
 * 1-16A — Horloge serveur des notifications (rappels, délais, reprises,
 * bilans, lecture). Remplacée UNIQUEMENT par les tests (`overrideProvider`).
 */
export const PUSH_CLOCK = Symbol('PUSH_CLOCK');

export type PushClock = () => Date;

export const systemPushClock: PushClock = () => new Date();

/**
 * 1-16A / 1-16A.1 — État d'activation des notifications DANS CE PROCESSUS.
 *
 * Deux niveaux, inactifs par défaut :
 * - `active` (traitement de fond) : enregistrement des événements dans les
 *   transactions métier, centre de notifications, rappels et bilans. Activé
 *   par le démarrage HTTP (`startNotifications`) MÊME si
 *   `WEB_PUSH_ENABLED=false` : le centre ne dépend pas du push ;
 * - `pushActive` : envois Web Push (configuration VAPID valide et
 *   `WEB_PUSH_ENABLED=true`), implique `active`.
 *
 * Charger `AppModule` (CLI `createApplicationContext`, migrations, tests)
 * n'active rien : aucun événement, aucune écriture implicite, aucun envoi.
 */
@Injectable()
export class PushRuntime {
  private background = false;
  private push: {
    config: EnabledWebPushConfig;
    transport: PushTransport;
  } | null = null;

  /** Centre et traitement de fond, sans push. */
  activateCenter(): void {
    this.background = true;
  }

  /** Centre, traitement de fond ET push. */
  activate(config: EnabledWebPushConfig, transport: PushTransport): void {
    this.background = true;
    this.push = { config, transport };
  }

  deactivate(): void {
    this.background = false;
    this.push = null;
  }

  /** Traitement de fond actif (processus HTTP). */
  get active(): boolean {
    return this.background;
  }

  get pushActive(): boolean {
    return this.push !== null;
  }

  get publicKey(): string | null {
    return this.push?.config.publicKey ?? null;
  }

  get transport(): PushTransport | null {
    return this.push?.transport ?? null;
  }
}
