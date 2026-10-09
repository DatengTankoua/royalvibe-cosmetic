import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './events/origin.helpers';
import {
  applyTrustProxy,
  resolveTrustProxySetting,
} from './common/trust-proxy';
import type { ExpressSettings } from './common/trust-proxy';
import { API_APPLICATION_OPTIONS } from './common/application-options';
import { resolveWebPushConfig } from './push/push-config';
import { startNotifications } from './push/push-bootstrap';
import { configureProcessTimeZone } from './analytics/month-range';
import { startStorageRecovery } from './storage-quota/storage-recovery';
import { resolveTurnstileConfig } from './anti-bot/turnstile-config';
import { resolveAntiAbuseConfig } from './common/rate-limit/anti-abuse-config';

async function bootstrap() {
  // 1-16D : fuseau des mois (Analyse, historique exportable, bilan
  // mensuel), validé et appliqué AVANT toute création de date. Lancement
  // au Cameroun : TZ=Africa/Douala (README, variables de production).
  const timeZone = configureProcessTimeZone();
  new Logger('Bootstrap').log(`Fuseau des bornes mensuelles : ${timeZone}`);
  // CORS HTTP fermé (phase 0B.4) : la config est parsée UNE FOIS au
  // démarrage via le parser strict de 0B.3 — aucune `?? true`, aucun
  // wildcard. En production, `parseCORSOrigin` lève OriginConfigError si
  // CORS_ORIGIN est absente ou invalide => démarrage bloqué (garde
  // vérifiée E2E et par origin.helpers.spec.ts).
  const environment =
    process.env.NODE_ENV === 'production' ? 'production' : 'development';
  const corsAllowlist = buildOriginAllowlist(
    parseCORSOrigin(process.env.CORS_ORIGIN, environment),
  );

  // Reverse proxy (0B.6, 1-14D.2E) : confiance parsée de façon STRICTE
  // avant la création de l'app. Défaut : aucun proxy approuvé (on ne se fie
  // PAS à `X-Forwarded-For`). `TRUST_PROXY_ADDRESSES` (adresses exactes des
  // proxys identifiés) ou `TRUST_PROXY_HOPS` (N sauts), jamais les deux ;
  // toute valeur invalide → erreur fatale au démarrage.
  const trustProxy = resolveTrustProxySetting(process.env);

  // 1-18C : anti-robot de l'inscription et plafonds persistants, validés
  // STRICTEMENT (valeur invalide, clé de test ou simulation en production →
  // erreur fatale). Seul le mode est journalisé, jamais le secret.
  const turnstile = resolveTurnstileConfig(process.env);
  resolveAntiAbuseConfig(process.env);
  new Logger('Bootstrap').log(
    `Anti-robot de l'inscription : ${turnstile.mode}`,
  );
  if (
    turnstile.mode === 'unconfigured' &&
    process.env.PUBLIC_REGISTRATION_ENABLED === 'true'
  ) {
    new Logger('Bootstrap').warn(
      'Inscription publique ouverte sans Turnstile : chaque inscription sera refusée (503).',
    );
  }

  // Web Push (1-16A) : désactivé par défaut ; `WEB_PUSH_ENABLED=true` avec
  // une configuration VAPID invalide → erreur fatale au démarrage.
  const webPush = resolveWebPushConfig(process.env);

  const app = await NestFactory.create(AppModule, API_APPLICATION_OPTIONS);

  // trust proxy : réglé UNIQUEMENT si un proxy est approuvé. Express calcule
  // alors `req.ip` depuis les sauts/adresses approuvés ; sinon `req.ip` est
  // l'adresse de la socket (aucune lecture manuelle de `X-Forwarded-For`).
  applyTrustProxy(
    app.getHttpAdapter().getInstance() as ExpressSettings,
    trustProxy,
  );

  // Factory UNIQUE des options CORS strictes (partagée avec les E2E) :
  // origines exactes ; Origin absent ou inconnu SANS en-tête CORS et SANS
  // 500 ; méthodes/headers explicites ; pas de `credentials` (Bearer).
  app.enableCors(buildHttpCorsOptions(corsAllowlist));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  // Centre de notifications et traitement de fond (1-16A.1), push si
  // configuré : démarrage HTTP UNIQUEMENT (les CLI chargent `AppModule` sans
  // jamais passer par ici).
  await startNotifications(app, webPush);
  // 1-17B : reprise des envois et suppressions de fichiers interrompus
  // (processus HTTP uniquement).
  startStorageRecovery(app);

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
