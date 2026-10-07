import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AnalyticsController } from '../analytics/analytics.controller';
import { AppController } from '../app.controller';
import { AuthController } from '../auth/auth.controller';
import { ObjectsController } from '../objects/objects.controller';
import { OrganizationBrandingController } from '../organizations/organization-branding.controller';
import { OrganizationMembersController } from '../organizations/organization-members.controller';
import { OrganizationsController } from '../organizations/organizations.controller';
import { ProductsController } from '../products/products.controller';
import { SalesController } from '../sales/sales.controller';
import { SectionsController } from '../sections/sections.controller';
import { TrashController } from '../trash/trash.controller';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionPaymentsController } from './payments/subscription-payments.controller';
import { CamPayWebhookController } from './payments/campay/campay-webhook.controller';
import { PushController } from '../push/push.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { SupportController } from '../support/support.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { SKIP_ORGANIZATION_CONTEXT_KEY } from '../auth/decorators/skip-organization-context.decorator';
import {
  OWNER_ONLY_KEY,
  PERMISSIONS_KEY,
} from '../auth/decorators/permissions.decorator';
import { SUBSCRIPTION_ACCESS_EXEMPTION_KEY } from './subscription-access';

/**
 * 1-14C.1 — Matrice des routes, calculée depuis les MÉTADONNÉES RÉELLES de
 * tous les contrôleurs (aucune liste déclarative parallèle au code) :
 * publique / identification et état / renouvellement propriétaire /
 * métier. Toute nouvelle route est « métier » (refus commercial par
 * défaut) tant qu'elle ne porte pas une exception explicite — ce test
 * échoue si une exception apparaît ou disparaît sans mise à jour.
 */
const CONTROLLERS = [
  AnalyticsController,
  AppController,
  AuthController,
  ObjectsController,
  OrganizationBrandingController,
  OrganizationMembersController,
  OrganizationsController,
  ProductsController,
  SalesController,
  SectionsController,
  SubscriptionsController,
  SubscriptionPaymentsController,
  CamPayWebhookController,
  TrashController,
  PushController,
  NotificationsController,
  SupportController,
];

type Category =
  'public' | 'identity' | 'owner-renewal' | 'business:sale-replay' | 'business';

interface Route {
  route: string;
  category: Category;
  skipsOrganizationContext: boolean;
}

function join(prefix: string, path: string): string {
  const parts = [prefix, path].filter((p) => p && p !== '/');
  return `/${parts.join('/')}`;
}

function collectRoutes(): Route[] {
  const routes: Route[] = [];
  for (const controller of CONTROLLERS) {
    const prefix = (Reflect.getMetadata(PATH_METADATA, controller) ??
      '') as string;
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) ??
        '') as string;
      const meta = (key: string) =>
        Reflect.getMetadata(key, handler) ??
        Reflect.getMetadata(key, controller);
      const exemption = meta(SUBSCRIPTION_ACCESS_EXEMPTION_KEY) as
        string | undefined;
      let category: Category = 'business';
      if (meta(IS_PUBLIC_KEY) === true) category = 'public';
      else if (exemption === 'identity') {
        category =
          meta(OWNER_ONLY_KEY) === undefined ? 'identity' : 'owner-renewal';
      } else if (exemption === 'sale-replay') category = 'business:sale-replay';
      routes.push({
        route: `${RequestMethod[method]} ${join(prefix, path)}`,
        category,
        skipsOrganizationContext: meta(SKIP_ORGANIZATION_CONTEXT_KEY) === true,
      });
    }
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route));
}

const byCategory = (category: Category) =>
  collectRoutes()
    .filter((r) => r.category === category)
    .map((r) => r.route);

describe('Matrice des routes — contrôle commercial (1-14C.1)', () => {
  it('publiques : inscription, login, invitations, email, mot de passe, health, webhook CamPay (1-14D.2F, signature HS256)', () => {
    expect(byCategory('public')).toEqual(
      [
        'GET /health',
        'GET /payments/webhooks/campay',
        'POST /payments/webhooks/campay',
        'POST /auth/email-verification/confirm',
        'POST /auth/email-verification/request',
        'POST /auth/invitations/accept',
        'POST /auth/login',
        'POST /auth/password-reset/confirm',
        'POST /auth/password-reset/request',
        'POST /auth/register',
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('identification et état : liste fermée', () => {
    expect(byCategory('identity')).toEqual(
      [
        'GET /auth/context',
        'GET /auth/me',
        'GET /auth/organizations',
        'POST /auth/subscription-access/complete',
        'POST /auth/switch-organization',
        // 1-16A : retrait de l'appareil de l'utilisateur courant (déconnexion
        // d'une session limitée ou d'une organisation expirée).
        'POST /notifications/push/subscription/remove',
      ].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('centre de notifications (1-16A.1) : toutes les routes métier, sans exception commerciale', () => {
    const center = collectRoutes().filter((r) =>
      /^\/notifications(\/|$)(?!push)/.test(r.route.split(' ')[1]),
    );
    expect(center.map((r) => r.route)).toEqual(
      [
        'GET /notifications',
        'GET /notifications/:id/report/unsold',
        'GET /notifications/preferences',
        'GET /notifications/unread-count',
        'POST /notifications/:id/open',
        'POST /notifications/:id/read',
        'POST /notifications/read-all',
        'PUT /notifications/preferences',
      ].sort((a, b) => a.localeCompare(b)),
    );
    for (const route of center) {
      expect(route.category).toBe('business');
      expect(route.skipsOrganizationContext).toBe(false);
    }
  });

  it('notifications push (1-16A) : gestion métier par défaut, seul le retrait est exempté', () => {
    const push = collectRoutes().filter((r) =>
      r.route.split(' ')[1].startsWith('/notifications/push'),
    );
    expect(push).toEqual(
      [
        {
          route: 'GET /notifications/push/config',
          category: 'business',
          skipsOrganizationContext: false,
        },
        {
          route: 'PATCH /notifications/push/subscription',
          category: 'business',
          skipsOrganizationContext: false,
        },
        {
          route: 'POST /notifications/push/subscription',
          category: 'business',
          skipsOrganizationContext: false,
        },
        {
          route: 'POST /notifications/push/subscription/remove',
          category: 'identity',
          skipsOrganizationContext: false,
        },
        {
          route: 'POST /notifications/push/subscription/status',
          category: 'business',
          skipsOrganizationContext: false,
        },
      ].sort((a, b) => a.route.localeCompare(b.route)),
    );
  });

  it('renouvellement propriétaire : lecture d’abonnement et paiements (1-14D.2B), owner-only uniquement', () => {
    expect(byCategory('owner-renewal')).toEqual(
      [
        'GET /organizations/current/subscription',
        'GET /organizations/current/subscription/payments',
        'GET /organizations/current/subscription/payments/:paymentId',
        'POST /organizations/current/subscription/payments',
        'POST /organizations/current/subscription/payments/:paymentId/refresh',
      ].sort((a, b) => a.localeCompare(b)),
    );
    // Paiements : opération owner-only DÉDIÉE, aucune permission délégable.
    for (const name of ['create', 'list', 'get', 'refresh']) {
      const paymentHandler = (
        SubscriptionPaymentsController.prototype as unknown as Record<
          string,
          object
        >
      )[name];
      expect(
        Reflect.getMetadata(OWNER_ONLY_KEY, paymentHandler) ??
          Reflect.getMetadata(OWNER_ONLY_KEY, SubscriptionPaymentsController),
      ).toBe('billing.payment');
      expect(
        Reflect.getMetadata(PERMISSIONS_KEY, paymentHandler) ??
          Reflect.getMetadata(PERMISSIONS_KEY, SubscriptionPaymentsController),
      ).toBeUndefined();
    }
    const handler = (
      SubscriptionsController.prototype as unknown as Record<string, object>
    ).current;
    expect(Reflect.getMetadata(OWNER_ONLY_KEY, handler)).toBe(
      'billing.identity',
    );
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toBeUndefined();
  });

  it('assistance (1-16C.1) : routes métier, contexte d’organisation, permission support.contact, aucune exception', () => {
    const support = collectRoutes().filter((r) =>
      r.route.split(' ')[1].startsWith('/support'),
    );
    expect(support).toEqual([
      {
        route: 'GET /support/context',
        category: 'business',
        skipsOrganizationContext: false,
      },
      {
        route: 'POST /support/requests',
        category: 'business',
        skipsOrganizationContext: false,
      },
    ]);
    for (const name of ['context', 'submit']) {
      const handler = (
        SupportController.prototype as unknown as Record<string, object>
      )[name];
      const meta = (key: string): unknown =>
        Reflect.getMetadata(key, handler) ??
        Reflect.getMetadata(key, SupportController);
      expect(meta(PERMISSIONS_KEY)).toEqual(['support.contact']);
      expect(meta(OWNER_ONLY_KEY)).toBeUndefined();
      expect(meta(SUBSCRIPTION_ACCESS_EXEMPTION_KEY)).toBeUndefined();
      expect(meta(IS_PUBLIC_KEY)).toBeUndefined();
    }
  });

  it('confirmation de vente déjà appliquée : POST /sales seul', () => {
    expect(byCategory('business:sale-replay')).toEqual(['POST /sales']);
  });

  it('métier (refus par défaut) : catalogue, sections, produits, ventes, analytics, corbeille, objets, administration', () => {
    const business = byCategory('business');
    for (const prefix of [
      '/analytics',
      '/objects',
      '/organizations/current',
      '/organizations/invitations',
      '/organizations/members',
      '/products',
      '/sales',
      '/sections',
      '/trash',
    ]) {
      expect(business.some((r) => r.split(' ')[1].startsWith(prefix))).toBe(
        true,
      );
    }
    // Branding, membres et invitations ne bénéficient JAMAIS d'une exception.
    const exempted = [
      ...byCategory('identity'),
      ...byCategory('owner-renewal'),
      ...byCategory('business:sale-replay'),
    ];
    for (const route of exempted) {
      expect(route).not.toMatch(
        /\/organizations\/(members|invitations)|\/organizations\/current\/(branding|logo)|^GET \/organizations\/current$/,
      );
    }
  });

  it('toute route sans contexte d’organisation porte une exception explicite', () => {
    const skipping = collectRoutes().filter((r) => r.skipsOrganizationContext);
    expect(skipping.map((r) => r.route)).toEqual([
      'GET /auth/organizations',
      'POST /auth/switch-organization',
    ]);
    for (const route of skipping) expect(route.category).toBe('identity');
  });
});
