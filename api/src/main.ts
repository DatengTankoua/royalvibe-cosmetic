import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './events/origin.helpers';
import { resolveTrustProxyHops } from './common/auth-rate-limiting';

async function bootstrap() {
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

  // Reverse proxy (0B.6) : le nombre de proxys approuvés est parsé de façon
  // STRICTE avant la création de l'app. Absent/vide/`0` → aucun proxy
  // approuvé (on ne se fie PAS à `X-Forwarded-For`). Entier positif → ce
  // nombre exact de proxys approuvés. Valeur négative/décimale/texte →
  // erreur fatale au démarrage (aucun défaut deviné pour la production).
  const trustProxyHops = resolveTrustProxyHops(process.env.TRUST_PROXY_HOPS);

  const app = await NestFactory.create(AppModule);

  // trust proxy : appelé UNIQUEMENT si la valeur est strictement positive.
  // Express calcule alors `req.ip` à partir des hops approuvés ; sinon on se
  // fie uniquement à l'adresse de la socket (pas de lecture manuelle de
  // `X-Forwarded-For`).
  if (trustProxyHops > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyHops);
  }

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

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
