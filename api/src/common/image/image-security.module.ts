import { Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { configureSharpSecurityPolicy } from './sharp-security-policy';

/**
 * 1-12D — Applique la politique Sharp au bootstrap de CHAQUE application
 * Nest (production via `main.ts`, applications E2E via `app.init()`), avant
 * toute requête. Ne dépend pas de `main.ts`.
 */
@Injectable()
export class SharpSecurityPolicyInitializer implements OnApplicationBootstrap {
  onApplicationBootstrap(): void {
    configureSharpSecurityPolicy();
  }
}

@Module({ providers: [SharpSecurityPolicyInitializer] })
export class ImageSecurityModule {}
