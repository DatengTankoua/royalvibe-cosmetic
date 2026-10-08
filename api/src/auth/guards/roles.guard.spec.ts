import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { UserRole } from '../../users/schemas/user.schema';
import { SectionsController } from '../../sections/sections.controller';
import { ProductsController } from '../../products/products.controller';
import { SalesController } from '../../sales/sales.controller';
import { TrashController } from '../../trash/trash.controller';
import { AnalyticsController } from '../../analytics/analytics.controller';

/**
 * Reads the @Roles([...]) metadata exactly as Nest 11 stores it.
 * `SetMetadata` (reflect-metadata) defines the metadata on the
 * decorator target: for method decorators that is the handler function
 * object itself (the same one the global RolesGuard reflects at
 * runtime), for class decorators the controller class. Reading from
 * `prototype[methodName]` (with a class-level fallback) is therefore
 * the authoritative source of the current permission matrix.
 */
function readRoles(
  controllerType: object,
  methodName: string,
): UserRole[] | undefined {
  const proto = (controllerType as { prototype: Record<string, unknown> })
    .prototype;
  const handler = proto[methodName];
  if (typeof handler === 'function') {
    const onHandler = Reflect.getMetadata(ROLES_KEY, handler) as
      UserRole[] | undefined;
    if (onHandler) return onHandler;
  }
  const onClass = Reflect.getMetadata(ROLES_KEY, controllerType) as
    UserRole[] | undefined;
  return onClass ?? undefined;
}

/** Minimal ExecutionContext whose request carries a given user. */
function makeContext(user: { role: UserRole } | undefined) {
  return {
    getHandler: () => () => undefined,
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
}

/** RolesGuard with a stub reflector that reports a fixed required-role list. */
function makeGuard(requiredRoles: UserRole[] | null): RolesGuard {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard', () => {
  describe('decision logic (reflector stubbed)', () => {
    it('refuses an admin operation for a seller with a 403-class error', () => {
      const guard = makeGuard([UserRole.ADMIN]);
      expect(() =>
        guard.canActivate(makeContext({ role: UserRole.SELLER })),
      ).toThrow(ForbiddenException);
    });

    it('allows an admin operation for an admin', () => {
      const guard = makeGuard([UserRole.ADMIN]);
      expect(guard.canActivate(makeContext({ role: UserRole.ADMIN }))).toBe(
        true,
      );
    });

    it('treats the absence of @Roles as "any authenticated user allowed"', () => {
      // No @Roles decorator => requiredRoles is undefined => the guard
      // passes for any authenticated user. This is the current behaviour
      // that leaves read endpoints open to sellers.
      const guard = makeGuard(null);
      expect(guard.canActivate(makeContext({ role: UserRole.SELLER }))).toBe(
        true,
      );
    });

    it('refuses a role-gated operation cleanly with a 403-class error when request.user is absent (no TypeError)', () => {
      // Required behaviour (phase 0B.1): a missing user with a required
      // role is a controlled rejection (ForbiddenException), never an
      // unhandled TypeError that would surface as a 500.
      const guard = makeGuard([UserRole.ADMIN]);
      let thrown: unknown;
      try {
        guard.canActivate(makeContext(undefined));
      } catch (e: unknown) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect(thrown).not.toBeInstanceOf(TypeError);
    });

    it('does not throw when the user is missing and no role is required', () => {
      const guard = makeGuard(null);
      expect(guard.canActivate(makeContext(undefined))).toBe(true);
    });
  });

  describe('1-7B — @Roles retiré des contrôleurs métier migrés (PermissionGuard prend le relais)', () => {
    /** Même priorité que `Reflector.getAllAndOverride` : handler puis classe. */
    function readPermissions(
      controllerType: object,
      methodName?: string,
    ): string[] | undefined {
      const proto = (controllerType as { prototype: Record<string, unknown> })
        .prototype;
      if (methodName) {
        const handler = proto[methodName];
        if (typeof handler === 'function') {
          const onHandler = Reflect.getMetadata(PERMISSIONS_KEY, handler) as
            string[] | undefined;
          if (onHandler) return onHandler;
        }
      }
      return Reflect.getMetadata(PERMISSIONS_KEY, controllerType) as
        string[] | undefined;
    }

    const migratedRoutes: [
      label: string,
      controller: object,
      method: string,
      permission: string,
    ][] = [
      ['sections.create', SectionsController, 'create', 'catalog.manage'],
      ['sections.update', SectionsController, 'update', 'catalog.manage'],
      ['sections.restore', SectionsController, 'restore', 'trash.manage'],
      ['sections.remove', SectionsController, 'remove', 'catalog.manage'],
      [
        'sections.permanentDelete',
        SectionsController,
        'permanentDelete',
        'trash.manage',
      ],
      ['products.create', ProductsController, 'create', 'products.manage'],
      ['products.restore', ProductsController, 'restore', 'trash.manage'],
      ['products.remove', ProductsController, 'remove', 'products.manage'],
      [
        'products.permanentDelete',
        ProductsController,
        'permanentDelete',
        'trash.manage',
      ],
      ['sales.create', SalesController, 'create', 'sales.record'],
      ['sales.update', SalesController, 'update', 'sales.record'],
      ['sales.remove', SalesController, 'remove', 'sales.record'],
      [
        'analytics.getOverview',
        AnalyticsController,
        'getOverview',
        'analytics.read',
      ],
      [
        'analytics.getProductsRanking',
        AnalyticsController,
        'getProductsRanking',
        'analytics.read',
      ],
      [
        'analytics.getSellersRanking',
        AnalyticsController,
        'getSellersRanking',
        'analytics.read',
      ],
      [
        'analytics.getMonthlyTrend',
        AnalyticsController,
        'getMonthlyTrend',
        'analytics.read',
      ],
      ['trash.findAll', TrashController, 'findAll', 'trash.manage'],
    ];

    it.each(migratedRoutes.map(([label]) => [label]))(
      '%s : @Roles absent (RolesGuard non impliqué)',
      (label) => {
        const entry = migratedRoutes.find((e) => e[0] === label)!;
        expect(readRoles(entry[1], entry[2])).toBeUndefined();
      },
    );

    it.each(migratedRoutes.map(([label]) => [label]))(
      '%s : @RequirePermissions déclare exactement la permission attendue',
      (label) => {
        const entry = migratedRoutes.find((e) => e[0] === label)!;
        expect(readPermissions(entry[1], entry[2])).toEqual([entry[3]]);
      },
    );

    const openRoutes: [label: string, controller: object, method: string][] = [
      ['sections.findAll', SectionsController, 'findAll'],
      ['sections.findOne', SectionsController, 'findOne'],
      ['products.findAll', ProductsController, 'findAll'],
      ['products.findOne', ProductsController, 'findOne'],
      ['sales.findAll', SalesController, 'findAll'],
      // Correctif 1-7B : la permission requise dépend des champs touchés
      // (products.manage / stock.adjust / les deux) — décidée dans le
      // handler, jamais une métadonnée statique.
      ['products.update', ProductsController, 'update'],
    ];

    it.each(openRoutes.map(([label]) => [label]))(
      '%s : sans @Roles ni @RequirePermissions (ouverte à tout membre actif, §3 audit 1A)',
      (label) => {
        const entry = openRoutes.find((e) => e[0] === label)!;
        expect(readRoles(entry[1], entry[2])).toBeUndefined();
        expect(readPermissions(entry[1], entry[2])).toBeUndefined();
      },
    );

    it('a seller therefore passes RolesGuard on every route above (RolesGuard reste enregistré, mais inerte ici)', () => {
      const guard = makeGuard(null);
      expect(guard.canActivate(makeContext({ role: UserRole.SELLER }))).toBe(
        true,
      );
    });
  });
});
