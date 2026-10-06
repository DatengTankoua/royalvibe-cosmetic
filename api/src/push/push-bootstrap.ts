import type { INestApplication } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { WebPushConfig } from './push-config';
import { verifyPushIndexes } from './push-indexes';
import { PushRuntime } from './push-runtime';
import { PushDispatcherService } from './push-dispatcher.service';
import { WebPushTransport } from './push-transport';

/**
 * 1-16A / 1-16A.1 — Activation des notifications, appelée UNIQUEMENT par le
 * démarrage HTTP (`main.ts`), après `resolveWebPushConfig`.
 *
 * - Toujours : centre de notifications et traitement de fond (événements,
 *   rappels, bilans mensuels), même avec `WEB_PUSH_ENABLED=false`.
 * - `WEB_PUSH_ENABLED=true` : en plus, envois Web Push (transport réel).
 * - Index vérifiés en production, et dès que le push est activé (sinon le
 *   démarrage échoue avec la commande de migration).
 *
 * Jamais appelé par les CLI, migrations, simulations ni tests (qui chargent
 * `AppModule` sans rien démarrer).
 */
export async function startNotifications(
  app: INestApplication,
  config: WebPushConfig,
  environment: string | undefined = process.env.NODE_ENV,
): Promise<void> {
  const logger = new Logger('Notifications');
  if (environment === 'production' || config.enabled) {
    await verifyPushIndexes(app.get<Connection>(getConnectionToken()));
  }
  const runtime = app.get(PushRuntime);
  if (config.enabled) {
    runtime.activate(config, new WebPushTransport(config));
  } else {
    runtime.activateCenter();
  }
  app.get(PushDispatcherService).start();
  logger.log(
    config.enabled
      ? 'Centre de notifications et push activés (traitement de fond démarré).'
      : 'Centre de notifications activé ; push désactivé (WEB_PUSH_ENABLED).',
  );
}
