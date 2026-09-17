import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
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

    it('documents the unauthenticated contract: RolesGuard alone does NOT 403 a missing user — it assumes JwtAuthGuard ran first', () => {
      // Current code: `user.role` with user === undefined throws a
      // TypeError (unhandled => 500) instead of a clean 403. In
      // production this is masked because JwtAuthGuard is a global
      // APP_GUARD registered BEFORE RolesGuard (auth.module.ts) and
      // rejects unauthenticated requests with 401 first.
      // Pinned here so any future "graceful degradation" change is
      // deliberate. (Documented current behaviour, not a regression.)
      const guard = makeGuard([UserRole.ADMIN]);
      expect(() => guard.canActivate(makeContext(undefined))).toThrow(
        TypeError,
      );
    });
  });

  describe('current permission matrix (real @Roles decorators)', () => {
    const adminOnlyRoutes: [
      label: string,
      controller: object,
      method: string,
    ][] = [
      ['sections.create', SectionsController, 'create'],
      ['sections.update', SectionsController, 'update'],
      ['sections.restore', SectionsController, 'restore'],
      ['sections.remove', SectionsController, 'remove'],
      ['sections.permanentDelete', SectionsController, 'permanentDelete'],
      ['products.create', ProductsController, 'create'],
      ['products.update', ProductsController, 'update'],
      ['products.restore', ProductsController, 'restore'],
      ['products.remove', ProductsController, 'remove'],
      ['products.permanentDelete', ProductsController, 'permanentDelete'],
      ['sales.update', SalesController, 'update'],
      ['sales.remove', SalesController, 'remove'],
      ['trash.findAll (controller-level @Roles)', TrashController, 'findAll'],
    ];

    it.each(adminOnlyRoutes.map(([label]) => [label]))(
      '%s is declared ADMIN-only',
      (label) => {
        const entry = adminOnlyRoutes.find((e) => e[0] === label);
        expect(entry).toBeDefined();
        expect(readRoles(entry![1], entry![2])).toEqual([UserRole.ADMIN]);
      },
    );

    const anyAuthRoute: [label: string, controller: object, method: string][] =
      [
        ['sections.findAll', SectionsController, 'findAll'],
        ['sections.findOne', SectionsController, 'findOne'],
        ['products.findAll', ProductsController, 'findAll'],
        ['products.findOne', ProductsController, 'findOne'],
        ['sales.create', SalesController, 'create'],
        ['sales.findAll', SalesController, 'findAll'],
        ['analytics.getOverview', AnalyticsController, 'getOverview'],
        [
          'analytics.getProductsRanking',
          AnalyticsController,
          'getProductsRanking',
        ],
        [
          'analytics.getSellersRanking',
          AnalyticsController,
          'getSellersRanking',
        ],
        ['analytics.getMonthlyTrend', AnalyticsController, 'getMonthlyTrend'],
      ];

    it.each(anyAuthRoute.map(([label]) => [label]))(
      '%s has NO @Roles (any authenticated user, incl. seller)',
      (label) => {
        const entry = anyAuthRoute.find((e) => e[0] === label);
        expect(entry).toBeDefined();
        expect(readRoles(entry![1], entry![2])).toBeUndefined();
      },
    );

    it('a seller therefore passes RolesGuard on every route above', () => {
      const guard = makeGuard(null);
      expect(guard.canActivate(makeContext({ role: UserRole.SELLER }))).toBe(
        true,
      );
    });

    it('DEFECT (C-2, documented, NOT fixed here): every analytics endpoint requires no role — a seller may read all KPIs and the seller ranking (emails + revenue of every seller)', () => {
      for (const method of [
        'getOverview',
        'getProductsRanking',
        'getSellersRanking',
        'getMonthlyTrend',
      ] as const) {
        expect(readRoles(AnalyticsController, method)).toBeUndefined();
      }
      const guard = makeGuard(null);
      expect(guard.canActivate(makeContext({ role: UserRole.SELLER }))).toBe(
        true,
      );
    });
  });
});
