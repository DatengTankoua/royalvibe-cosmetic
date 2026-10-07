import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import {
  AnalyticsService,
  INSIGHT_LIST_KINDS,
  type InsightListKind,
} from './analytics.service';
import { INSIGHT_THRESHOLDS } from './insight-thresholds';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  hasPermission,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';
import { localMonthKey } from './insights';

export const ANALYTICS_MONTH_INVALID = 'ANALYTICS_MONTH_INVALID';
export const ANALYTICS_LIST_INVALID = 'ANALYTICS_LIST_INVALID';
/** Garde-fou du décalage (bien au-delà de tout catalogue réel). */
const MAX_LIST_OFFSET = 100_000;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * 1-16E — droit financier : `analytics.read` (garde du contrôleur) ET
 * `products.view_financials`, relus en base pour CETTE requête (même règle
 * que l'historique mensuel 1-16D). Sans lui, gains, marges, capital investi
 * et coûts sont ABSENTS des réponses (jamais remplacés par 0).
 */
export function canReadFinancials(
  context: ResolvedOrganizationContext,
): boolean {
  return (
    hasPermission(context, 'analytics.read') &&
    hasPermission(context, 'products.view_financials')
  );
}

/** Mois `AAAA-MM` de l'aide à la décision : jamais futur (sinon 400). */
export function assertInsightsMonth(
  value: string | undefined,
  now: Date,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  const match = MONTH_PATTERN.exec(value);
  if (!match || Number(match[1]) < 2000 || value > localMonthKey(now)) {
    throw new BadRequestException({
      code: ANALYTICS_MONTH_INVALID,
      message: 'Mois invalide.',
    });
  }
  return value;
}

/**
 * 1-16E — paramètres d'une page de liste : liste connue, `offset` entier
 * ≥ 0, `limit` entier de 1 à la taille de page (par défaut). Sinon 400.
 */
export function parseInsightListQuery(query: {
  kind?: string;
  offset?: string;
  limit?: string;
}): { kind: InsightListKind; offset: number; limit: number } {
  const pageSize = INSIGHT_THRESHOLDS.listLimit;
  const integer = (value: string | undefined, fallback: number) =>
    value === undefined || value === ''
      ? fallback
      : /^\d{1,6}$/.test(value)
        ? Number(value)
        : NaN;
  const kind = query.kind as InsightListKind;
  const offset = integer(query.offset, 0);
  const limit = integer(query.limit, pageSize);
  if (
    !INSIGHT_LIST_KINDS.includes(kind) ||
    !(offset >= 0 && offset <= MAX_LIST_OFFSET) ||
    !(limit >= 1 && limit <= pageSize)
  ) {
    throw new BadRequestException({
      code: ANALYTICS_LIST_INVALID,
      message: 'Liste demandée invalide.',
    });
  }
  return { kind, offset, limit };
}

function withoutKeys<T extends object>(row: T, keys: readonly string[]) {
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !keys.includes(key)),
  ) as Partial<T>;
}

// KPIs, product/seller rankings include purchase prices and every
// seller's email + revenue: gated by `analytics.read` (1-7B, ex-admin-only).
// 1-16E : données financières en plus soumises à `products.view_financials`.
@Controller('analytics')
@RequirePermissions('analytics.read')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  /** 1-16E — priorités, ventes du mois, ce qui se vend (page Analyse). */
  @Get('insights')
  @Header('Cache-Control', 'no-store')
  getInsights(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const now = new Date();
    return this.analyticsService.getInsights(
      organizationContext.organizationId,
      { financials: canReadFinancials(organizationContext) },
      assertInsightsMonth(month, now),
      now,
    );
  }

  /**
   * 1-16E — suite d'une liste « Stock actuel » (pagination stable). La liste
   * « Prix à vérifier » exige le droit financier (403 sinon, sans calcul).
   */
  @Get('insights/list')
  @Header('Cache-Control', 'no-store')
  getInsightList(
    @Query('kind') kind: string | undefined,
    @Query('offset') offset: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const now = new Date();
    const page = parseInsightListQuery({ kind, offset, limit });
    const financials = canReadFinancials(organizationContext);
    if (page.kind === 'price' && !financials) {
      throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
    }
    return this.analyticsService.getInsightList(
      organizationContext.organizationId,
      { financials },
      page.kind,
      { offset: page.offset, limit: page.limit },
      assertInsightsMonth(month, now),
      now,
    );
  }

  @Get('overview')
  async getOverview(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const overview = await this.analyticsService.getOverview(
      organizationContext.organizationId,
      month,
    );
    return canReadFinancials(organizationContext)
      ? overview
      : withoutKeys(overview, ['totalInvested', 'netProfit', 'avgMargin']);
  }

  @Get('products/ranking')
  async getProductsRanking(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    const ranking = await this.analyticsService.getProductsRanking(
      organizationContext.organizationId,
      month,
    );
    return canReadFinancials(organizationContext)
      ? ranking
      : ranking.map((row) => withoutKeys(row, ['netProfit']));
  }

  @Get('sellers/ranking')
  getSellersRanking(
    @Query('month') month: string | undefined,
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getSellersRanking(
      organizationContext.organizationId,
      month,
    );
  }

  @Get('monthly')
  getMonthlyTrend(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
  ) {
    return this.analyticsService.getMonthlyTrend(
      organizationContext.organizationId,
    );
  }
}
