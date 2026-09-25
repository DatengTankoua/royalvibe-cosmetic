/**
 * 1-7A — Garde de permissions organisationnelles (matrice unitaire ciblée).
 *
 * Matrice : (1) sans métadonnée, (2) permission par défaut owner/admin/
 * seller, (3) permission supplémentaire seller, (4) permission manquante,
 * (5) plusieurs permissions (toutes requises), (6) owner-only autorisée/
 * refusée (valeur injectée ignorée), (7) contexte absent, (8) @Public et
 * non-HTTP, (9) aucune mutation du contexte, (10) aucun accès à
 * `request.user`, (11) ordre APP_GUARD exact.
 */
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthModule } from '../auth.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OrganizationGuard } from './organization.guard';
import { PermissionGuard } from './permission.guard';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import {
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import { OrganizationRole } from '../../organizations/permissions';

function makeContext(role: OrganizationRole): ResolvedOrganizationContext {
  return {
    userId: '112233445566778899001122',
    organizationId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    membershipId: '334455667788990011223344',
    role,
    permissions: [],
  };
}

interface ReflectorStub {
  isPublic?: boolean;
  requiredPermissions?: unknown;
  ownerOnlyOperation?: unknown;
}

/** Reflector stubbed to answer each metadata key independently, as Nest does. */
function makeReflector(stub: ReflectorStub): Reflector {
  return {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return stub.isPublic;
      if (key === PERMISSIONS_KEY) return stub.requiredPermissions;
      if (key === OWNER_ONLY_KEY) return stub.ownerOnlyOperation;
      return undefined;
    }),
  } as unknown as Reflector;
}

/** Minimal HTTP ExecutionContext; `request.user` is deliberately absent. */
function makeHttpContext(request: object) {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function makeNonHttpContext() {
  return {
    getType: () => 'ws',
    getHandler: () => () => undefined,
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as never;
}

describe('PermissionGuard', () => {
  it('1 — route sans métadonnée : laisse passer sans lire le contexte', () => {
    const guard = new PermissionGuard(makeReflector({}));
    const request = {}; // pas de organizationContext
    expect(guard.canActivate(makeHttpContext(request))).toBe(true);
  });

  it.each([
    [OrganizationRole.OWNER, 'catalog.manage'],
    [OrganizationRole.ADMIN, 'members.manage'],
    [OrganizationRole.SELLER, 'sales.record'],
  ] as const)(
    '2 — permission par défaut du rôle %s (%s) autorisée',
    (role, permission) => {
      const guard = new PermissionGuard(
        makeReflector({ requiredPermissions: [permission] }),
      );
      const request = { organizationContext: makeContext(role) };
      expect(guard.canActivate(makeHttpContext(request))).toBe(true);
    },
  );

  it('3 — permission supplémentaire seller (hors défaut) autorisée', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['analytics.read'] }),
    );
    const context = makeContext(OrganizationRole.SELLER);
    context.permissions.push('analytics.read');
    const request = { organizationContext: context };
    expect(guard.canActivate(makeHttpContext(request))).toBe(true);
  });

  it('4 — permission manquante : refus 403 PERMISSION_DENIED', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['analytics.read'] }),
    );
    const request = {
      organizationContext: makeContext(OrganizationRole.SELLER),
    };
    let thrown: unknown;
    try {
      guard.canActivate(makeHttpContext(request));
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'Permission insuffisante.',
    });
  });

  it('5 — plusieurs permissions : toutes requises (une manquante refuse)', () => {
    const guard = new PermissionGuard(
      makeReflector({
        requiredPermissions: ['sales.record', 'analytics.read'],
      }),
    );
    const request = {
      organizationContext: makeContext(OrganizationRole.SELLER),
    };
    expect(() => guard.canActivate(makeHttpContext(request))).toThrow(
      ForbiddenException,
    );
  });

  it('5b — plusieurs permissions : toutes présentes autorise', () => {
    const guard = new PermissionGuard(
      makeReflector({
        requiredPermissions: ['catalog.manage', 'members.manage'],
      }),
    );
    const request = {
      organizationContext: makeContext(OrganizationRole.ADMIN),
    };
    expect(guard.canActivate(makeHttpContext(request))).toBe(true);
  });

  it('6a — owner-only autorisée au owner', () => {
    const guard = new PermissionGuard(
      makeReflector({ ownerOnlyOperation: 'organization.delete' }),
    );
    const request = {
      organizationContext: makeContext(OrganizationRole.OWNER),
    };
    expect(guard.canActivate(makeHttpContext(request))).toBe(true);
  });

  it('6b — owner-only refusée à admin même avec la valeur injectée dans permissions', () => {
    const guard = new PermissionGuard(
      makeReflector({ ownerOnlyOperation: 'organization.delete' }),
    );
    const context = makeContext(OrganizationRole.ADMIN);
    // Injection malveillante simulée : jamais lue pour une opération owner-only.
    (context.permissions as string[]).push('organization.delete');
    const request = { organizationContext: context };
    expect(() => guard.canActivate(makeHttpContext(request))).toThrow(
      ForbiddenException,
    );
  });

  it('7 — contexte absent sur une route protégée : refus contrôlé, jamais 500', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['catalog.manage'] }),
    );
    const request = {}; // pas de organizationContext
    let thrown: unknown;
    try {
      guard.canActivate(makeHttpContext(request));
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  it('8a — @Public laisse passer même avec des métadonnées de permission', () => {
    const guard = new PermissionGuard(
      makeReflector({
        isPublic: true,
        requiredPermissions: ['catalog.manage'],
      }),
    );
    expect(guard.canActivate(makeHttpContext({}))).toBe(true);
  });

  it('8b — contexte non-HTTP laisse passer', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['catalog.manage'] }),
    );
    expect(guard.canActivate(makeNonHttpContext())).toBe(true);
  });

  it('9 — aucune mutation de request.organizationContext', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['catalog.manage'] }),
    );
    const context = makeContext(OrganizationRole.OWNER);
    const snapshot = JSON.parse(JSON.stringify(context)) as unknown;
    const request = { organizationContext: context };
    guard.canActivate(makeHttpContext(request));
    expect(JSON.parse(JSON.stringify(context))).toEqual(snapshot);
  });

  it('10 — aucun accès à request.user : la décision ne dépend que de organizationContext', () => {
    const guard = new PermissionGuard(
      makeReflector({ requiredPermissions: ['catalog.manage'] }),
    );
    // `user` absent de la requête : si la garde le lisait, elle lèverait une
    // TypeError plutôt que de statuer normalement.
    const request = {
      organizationContext: makeContext(OrganizationRole.OWNER),
    };
    expect(guard.canActivate(makeHttpContext(request))).toBe(true);
  });

  it('11 — ordre des gardes globales dans AuthModule : Jwt → Organization → Permission → Roles', () => {
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
