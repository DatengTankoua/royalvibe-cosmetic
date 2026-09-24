/**
 * 1-3B.2 — Garde organisationnelle HTTP.
 *
 * Rôle unique du principal `request.user` :
 * - `sub` = `user._id.toString()` (Mongoose ObjectId du document User chargé).
 * - `orgId` = `user.organizationId` — la propriété TRANSITOIRE attachée par
 *   `JwtStrategy.validate` depuis le claim signé du token (jamais d'un champ
 *   client ; cf. stratégie). `JwtAuthGuard` a déjà vérifié le token avant.
 *
 * Invariants :
 * - Non-HTTP (Socket.IO gateway) : passe sans résolution.
 * - Routes `@Public()` : exclues (MÊME clé `IS_PUBLIC_KEY` que `JwtAuthGuard`).
 * - `request.user` absent ou incomplet : 401 contrôlée, jamais d'exception 500.
 * - `resolveActiveContext` appelé UNE SEULE FOIS par requête.
 * - Le 403 UNIFORME de 1-3A (code `ORGANIZATION_ACCESS_DENIED`) remonte tel
 *   quel — ne le transformer JAMAIS.
 * - `request.user` n'est JAMAIS muté ; seul `request.organizationContext`
 *   est branché en lecture seule.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedPrincipal } from '../strategies/jwt.strategy';
import {
  OrganizationsService,
  ResolvedOrganizationContext,
} from '../../organizations/organizations.service';

type OrganizationGuardRequest = Request & {
  user?: AuthenticatedPrincipal;
  organizationContext?: ResolvedOrganizationContext;
};

@Injectable()
export class OrganizationGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private organizationsService: OrganizationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Non-HTTP : Socket.IO a son propre middleware d'auth (0B.3).
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<OrganizationGuardRequest>();

    // Principal absent/incomplet → 401 contrôlée.
    // Le check sur `_id` et `organizationId` est un invariant défensif :
    // le type déclaré les marque non-nullable mais en RUNTIME une régression
    // pourrait les laisser manquants — jamais de TypeError 500.
    // Sur les routes protégées `JwtStrategy` aurait déjà levé 401.
    if (!request.user || !request.user._id || !request.user.organizationId) {
      throw new UnauthorizedException();
    }

    const sub = request.user._id.toString();
    const orgId = request.user.organizationId;

    // Une seule résolution par requête. Le 403 UNIFORME remonte tel quel.
    const organizationContext =
      await this.organizationsService.resolveActiveContext(sub, orgId);

    // `request.user` reste INTACT ; seul `organizationContext` est branché.
    request.organizationContext = organizationContext;
    return true;
  }
}
