import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import {
  buildHttpCorsOptions,
  buildOriginAllowlist,
  parseCORSOrigin,
} from './events/origin.helpers';

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

  const app = await NestFactory.create(AppModule);

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
