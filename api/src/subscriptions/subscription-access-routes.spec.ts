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
      ].sort((a, b) => a.localeCompare(b)),
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
