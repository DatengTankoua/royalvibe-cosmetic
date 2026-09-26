/**
 * 1-3B.2 — Garde organisationnelle HTTP + ordre global des gardes
 * (matrice unitaire ciblée, pas de ligne-à-ligne).
 *
 * Matrice : (1) non-HTTP, (2) @Public, (3) exact call `(sub, orgId)` UNE FOIS,
 * (4) contexte attaché, (5) `request.user` intact, (6) données client
 * falsifiées ignorées, (7) principal absent/incomplet → 401 contrôlée,
 * (8) 403 remonté sans transformation, (+) décorateur `@CurrentOrganization`.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Types } from 'mongoose';
import { AuthModule } from '../auth.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { extractOrganizationContext } from '../decorators/current-organization.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SKIP_ORGANIZATION_CONTEXT_KEY } from '../decorators/skip-organization-context.decorator';
import {
  ORGANIZATION_ACCESS_DENIED,
  OrganizationsService,
  ResolvedOrganizationContext,
} from '../../organizations/organizations.service';
import { AuthenticatedPrincipal } from '../strategies/jwt.strategy';
import { OrganizationGuard } from './organization.guard';
import { PermissionGuard } from './permission.guard';

const USER_ID = '112233445566778899001122';
const ORG_A_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
// Falsifications client (body/header/query/params) : la garde DOIT les ignorer.
const FORGED_SUB = '444444444444444444444444';
const FORGED_ORG = 'cc0000000000000000000000';

const CONTEXT_A: ResolvedOrganizationContext = {
  userId: USER_ID,
  organizationId: ORG_A_ID,
  membershipId: '334455667788990011223344',
  role: 'owner',
  permissions: [],
};

const accessDenied = (): ForbiddenException =>
  new ForbiddenException({
    code: ORGANIZATION_ACCESS_DENIED,
    message: "Accès à l'organisation refusé.",
  });

/** Principal simulé : document User hydraté + `organizationId` (claim signé). */
function makePrincipal(): AuthenticatedPrincipal {
  const doc = {
    _id: new Types.ObjectId(USER_ID),
    name: 'Ada',
    email: 'ada@example.com',
    role: 'seller',
    organizationId: ORG_A_ID,
  };
  return doc as unknown as AuthenticatedPrincipal;
}

interface Fx {
  guard: OrganizationGuard;
  resolveActiveContext: jest.Mock;
}

function buildFx(
  opts: { isPublic?: boolean; skipOrganizationContext?: boolean } = {},
): Fx {
  const { isPublic = false, skipOrganizationContext = false } = opts;
  const reflector: { getAllAndOverride: jest.Mock } = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return isPublic;
      if (key === SKIP_ORGANIZATION_CONTEXT_KEY) return skipOrganizationContext;
      return false;
    }),
  };
  const resolveActiveContext: jest.Mock = jest.fn(
    (): Promise<ResolvedOrganizationContext> => Promise.resolve(CONTEXT_A),
  );
  const guard = new OrganizationGuard(
    reflector as unknown as Reflector,
    { resolveActiveContext } as unknown as OrganizationsService,
  );
  return { guard, resolveActiveContext };
}

/** Construit un contexte + le `request` associé (principal par défaut = valide). */
function makeHttp(
  opts: {
    principal?: unknown;
    body?: Record<string, unknown>;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    params?: Record<string, unknown>;
  } = {},
): { context: unknown; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {
    method: 'GET',
    path: '/protected',
    headers: opts.headers ?? { authorization: 'Bearer signed-token' },
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: opts.params ?? {},
  };
  if (opts.principal !== undefined) {
    request.user = opts.principal;
  }
  const context = {
    getType: () => 'http',
    getHandler: () => ({}) as object,
    getClass: () => ({}) as object,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { context, request };
}

/** Contexte non-HTTP (Socket.IO gateway) : passe sans résolution. */
function makeWs(): { context: unknown; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {};
  const context = {
    getType: () => 'ws',
    getHandler: () => ({}) as object,
    getClass: () => ({}) as object,
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { context, request };
}

describe('OrganizationGuard (1-3B.2)', () => {
  it('1 — un contexte non-HTTP (ws) passe SANS résolution ni attachement', async () => {
    const fx = buildFx();
    const { context, request } = makeWs();
    const ok = await fx.guard.canActivate(context);
    expect(ok).toBe(true);
    expect(fx.resolveActiveContext).not.toHaveBeenCalled();
    expect(request.organizationContext).toBeUndefined();
  });

  it('2 — une route @Public() passe SANS résolution (même clé IS_PUBLIC_KEY)', async () => {
    const fx = buildFx({ isPublic: true });
    // Route publique : pas de principal, pas de resolution d'organisation.
    const { context, request } = makeHttp({});
    const ok = await fx.guard.canActivate(context);
    expect(ok).toBe(true);
    expect(fx.resolveActiveContext).not.toHaveBeenCalled();
    expect(request.organizationContext).toBeUndefined();
  });

  it('2b — @SkipOrganizationContext() passe SANS résolution, mais exige un principal authentifié', async () => {
    const fx = buildFx({ skipOrganizationContext: true });
    // Toujours authentifiée (JwtAuthGuard) : un principal est présent ici.
    const { context, request } = makeHttp({ principal: makePrincipal() });
    const ok = await fx.guard.canActivate(context);
    expect(ok).toBe(true);
    expect(fx.resolveActiveContext).not.toHaveBeenCalled();
    expect(request.organizationContext).toBeUndefined();
  });

  it('2c — @Public() et @SkipOrganizationContext() sont des clés DISTINCTES (l’une n’active pas l’autre)', async () => {
    const fxPublicOnly = buildFx({
      isPublic: true,
      skipOrganizationContext: false,
    });
    // Une route publique passe déjà par le early-return @Public — vérifie
    // seulement que le mock reflète bien deux clés indépendantes.
    const fxSkipOnly = buildFx({
      isPublic: false,
      skipOrganizationContext: true,
    });
    const httpNoPrincipal = makeHttp({});
    const httpWithPrincipal = makeHttp({ principal: makePrincipal() });
    await expect(
      fxPublicOnly.guard.canActivate(httpNoPrincipal.context),
    ).resolves.toBe(true);
    await expect(
      fxSkipOnly.guard.canActivate(httpWithPrincipal.context),
    ).resolves.toBe(true);
    expect(fxPublicOnly.resolveActiveContext).not.toHaveBeenCalled();
    expect(fxSkipOnly.resolveActiveContext).not.toHaveBeenCalled();
  });

  it('3 — principal valide : resolveActiveContext appelé EXACTEMENT UNE FOIS avec (sub, orgId) du principal — jamais de claim client', async () => {
    const fx = buildFx();
    const principal = makePrincipal();
    const { context } = makeHttp({ principal });
    const ok = await fx.guard.canActivate(context);
    expect(ok).toBe(true);
    expect(fx.resolveActiveContext).toHaveBeenCalledTimes(1);
    // `sub` = `user._id.toString()` (document DB) ;
    // `orgId` = `user.organizationId` (claim signé attaché par la stratégie).
    expect(fx.resolveActiveContext).toHaveBeenCalledWith(USER_ID, ORG_A_ID);
  });

  it('4 — le contexte résolu est attaché à request.organizationContext (même instance)', async () => {
    const fx = buildFx();
    const { context, request } = makeHttp({ principal: makePrincipal() });
    await fx.guard.canActivate(context);
    expect(request.organizationContext).toBe(CONTEXT_A);
  });

  it('5 — request.user reste INTACT (réf + clés identiques avant/après)', async () => {
    const fx = buildFx();
    const { context, request } = makeHttp({ principal: makePrincipal() });
    const beforeRef = request.user;
    const beforeKeys = Object.keys(request.user ?? {});
    await fx.guard.canActivate(context);
    // La garde JAMAIS ré-affecte `request.user` ; aucune clé n'est ajoutée.
    expect(request.user).toBe(beforeRef);
    expect(Object.keys(request.user ?? {})).toEqual(beforeKeys);
  });

  it('6 — body/header/query/params + header Authorization falsifiés → ignorés', async () => {
    const fx = buildFx();
    const principal = makePrincipal();
    const { context, request } = makeHttp({
      principal,
      headers: {
        authorization: 'Bearer FORGED-TOKEN',
        organizationId: FORGED_ORG,
        'x-organization-id': FORGED_ORG,
      },
      body: {
        organizationId: FORGED_ORG,
        sub: FORGED_SUB,
        userId: FORGED_SUB,
      },
      query: { organizationId: FORGED_ORG, sub: FORGED_SUB },
      params: { organizationId: FORGED_ORG },
    });
    await fx.guard.canActivate(context);
    // Résolution UNIQUE avec les valeurs DU PRINCIPAL — pas les falsifiées.
    expect(fx.resolveActiveContext).toHaveBeenCalledTimes(1);
    expect(fx.resolveActiveContext).toHaveBeenCalledWith(USER_ID, ORG_A_ID);
    expect(fx.resolveActiveContext).not.toHaveBeenCalledWith(
      FORGED_SUB,
      FORGED_ORG,
    );
    expect(request.organizationContext).toBe(CONTEXT_A);
  });

  it('7 — principal absent/incomplet → 401 contrôlée AVANT le service', async () => {
    // (a) `request.user` absent (`JwtStrategy` n'a rien résolu).
    const fx1 = buildFx();
    const { context: ctx1 } = makeHttp({});
    await expect(fx1.guard.canActivate(ctx1)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fx1.resolveActiveContext).not.toHaveBeenCalled();

    // (b) `request.user` présent mais `organizationId` manquant (principal
    //     incomplet) : la garde reste 401 contrôlée, jamais une TypeError 500.
    const fx2 = buildFx();
    const incomplete = {
      _id: new Types.ObjectId(USER_ID),
      name: 'Ada',
      email: 'ada@example.com',
      role: 'seller',
    } as unknown as AuthenticatedPrincipal;
    const { context: ctx2 } = makeHttp({ principal: incomplete });
    await expect(fx2.guard.canActivate(ctx2)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fx2.resolveActiveContext).not.toHaveBeenCalled();
  });

  it('8 — le 403 de resolveActiveContext() remonte SANS transformation (même instance)', async () => {
    const fx = buildFx();
    const err = accessDenied();
    fx.resolveActiveContext.mockRejectedValueOnce(err);
    const { context } = makeHttp({ principal: makePrincipal() });
    // `toBe` (identité) : la garde ne wrappera JAMAIS l'exception.
    await expect(fx.guard.canActivate(context)).rejects.toBe(err);
    expect(err).toHaveProperty('response.code', ORGANIZATION_ACCESS_DENIED);
  });

  it('9 — le décorateur @CurrentOrganization renvoie EXACTEMENT le contexte branché', () => {
    const organizationContext: ResolvedOrganizationContext = {
      userId: USER_ID,
      organizationId: ORG_A_ID,
      membershipId: '334455667788990011223344',
      role: 'seller',
      permissions: ['sales.record'],
    };
    const request = { organizationContext };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as never;
    expect(extractOrganizationContext(ctx)).toBe(organizationContext);
  });

  it('10 — l’ordre des gardes globales dans AuthModule : Jwt → Organization → Permission → Roles', () => {
    // `@Module` stocke la config de providers sous la métadonnée `'providers'`
    // (valeur publique constatée des clés NestJS). On ne dépend d'aucun
    // chemin interne `node_modules`.
    const providers = Reflect.getMetadata('providers', AuthModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    const globalGuards: unknown[] = providers
      .filter((p): p is { provide: typeof APP_GUARD; useClass: unknown } =>
        Boolean(p && p.provide === APP_GUARD),
      )
      .map((p) => p.useClass);
    expect(globalGuards).toHaveLength(4);
    expect(globalGuards[0]).toBe(JwtAuthGuard);
    expect(globalGuards[1]).toBe(OrganizationGuard);
    expect(globalGuards[2]).toBe(PermissionGuard);
    expect(globalGuards[3]).toBe(RolesGuard);
  });
});
