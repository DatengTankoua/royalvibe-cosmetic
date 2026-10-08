import type { NestApplicationOptions } from '@nestjs/common';

/**
 * Options de création de l'application, partagées par `main.ts` et les e2e
 * qui doivent reproduire exactement le bootstrap.
 *
 * `rawBody` (1-14D.2F) : Nest conserve aussi le corps BRUT des requêtes
 * JSON / urlencoded (`req.rawBody`, borné par la limite par défaut des
 * parseurs). Le webhook CamPay s'en sert pour refuser les clés JSON
 * dupliquées, que `JSON.parse` écraserait silencieusement. Aucune autre
 * route ne le lit.
 */
export const API_APPLICATION_OPTIONS: NestApplicationOptions = Object.freeze({
  rawBody: true,
});
