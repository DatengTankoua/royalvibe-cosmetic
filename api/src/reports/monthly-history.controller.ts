import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Param,
  Req,
  Res,
  StreamableFile,
  UnprocessableEntityException,
} from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentOrganization } from '../auth/decorators/current-organization.decorator';
import type { ResolvedOrganizationContext } from '../organizations/organizations.service';
import {
  OrganizationRole,
  PERMISSION_DENIED_RESPONSE,
} from '../organizations/permissions';
import {
  assertReportMonth,
  MonthlyHistoryService,
} from './monthly-history.service';
import { renderMonthlyHistoryXlsx } from './monthly-history-xlsx';
import { renderMonthlyHistoryPdf } from './monthly-history-pdf';
import { REPORT_LABELS } from './report-labels';
import { PdfUnsupportedTextError } from './pdf/pdf-fonts';
import type { Request, Response } from 'express';
import { localeFromRequest, type AppLocale } from '../common/i18n/locale';
import {
  REPORT_RATE_LIMITED,
  ReportGenerationLimiter,
} from './report-generation-limiter';

export const REPORT_FORMATS = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
} as const;
export type ReportFormat = keyof typeof REPORT_FORMATS;
export const REPORT_FORMAT_INVALID = 'REPORT_FORMAT_INVALID';
export const REPORT_PDF_UNSUPPORTED_CHARACTERS =
  'REPORT_PDF_UNSUPPORTED_CHARACTERS';
/** Caractères cités dans le message (les autres sont comptés). */
const CITED_CHARACTERS = 5;

/** 422 : PDF refusé plutôt qu'altéré ; l'Excel reste exact. */
export function pdfUnsupportedException(
  error: PdfUnsupportedTextError,
  locale: AppLocale = 'fr',
): UnprocessableEntityException {
  const shown = error.characters.slice(0, CITED_CHARACTERS);
  const more = error.characters.length - CITED_CHARACTERS;
  // 1-16G : message composé directement dans la langue de la requête.
  const message =
    locale === 'en'
      ? `Some names for this month contain characters that the PDF cannot reproduce faithfully (${shown.map((c) => `“${c}”`).join(', ')}${more > 0 ? ` and ${more} other(s)` : ''}). Download the Excel version, which keeps them exactly.`
      : `Certains noms de ce mois contiennent des caractères que le PDF ne peut pas reproduire fidèlement (${shown.map((c) => `« ${c} »`).join(', ')}${more > 0 ? ` et ${more} autre(s)` : ''}). Téléchargez la version Excel, qui les conserve exactement.`;
  return new UnprocessableEntityException({
    code: REPORT_PDF_UNSUPPORTED_CHARACTERS,
    message,
    characters: error.characters.slice(0, CITED_CHARACTERS),
  });
}

/** Seuls ces rôles d'ORGANISATION téléchargent l'historique (1-16D). */
const REPORT_ROLES: ReadonlySet<OrganizationRole> = new Set([
  OrganizationRole.OWNER,
  OrganizationRole.ADMIN,
]);

/**
 * Le rôle et les droits viennent du contexte que les gardes globales ont
 * RELU EN BASE pour cette requête (session, organisation et appartenance
 * actives, abonnement, permissions) : jamais du navigateur ni du JWT.
 */
function assertReportAccess(context: ResolvedOrganizationContext): void {
  if (!REPORT_ROLES.has(context.role)) {
    throw new ForbiddenException(PERMISSION_DENIED_RESPONSE);
  }
}

/**
 * Préfixe ASCII sûr des fichiers : `historique-<slug>` (1-16G : en anglais
 * `sales-history-<slug>`).
 */
export function reportFilenamePrefix(
  slug: string,
  locale: AppLocale = 'fr',
): string {
  const safe =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'commerce';
  return `${locale === 'en' ? 'sales-history' : 'historique'}-${safe}`;
}

/** `historique-<slug>-AAAA-MM.<ext>`. */
export function reportFilename(
  slug: string,
  month: string,
  format: ReportFormat,
  locale: AppLocale = 'fr',
): string {
  return `${reportFilenamePrefix(slug, locale)}-${month}.${format}`;
}

/**
 * 1-16D — historique mensuel exportable. Contient toutes les ventes, les
 * vendeurs, les acheteurs et les gains : `analytics.read` ET
 * `sales.view_all` (vérifiées par `PermissionGuard`), puis rôle
 * propriétaire ou administrateur. Route métier : refus commercial par
 * défaut (abonnement inactif, session limitée).
 */
@Controller('reports/monthly')
@RequirePermissions('analytics.read', 'sales.view_all')
export class MonthlyHistoryController {
  constructor(
    private readonly history: MonthlyHistoryService,
    private readonly limiter: ReportGenerationLimiter,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async months(
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Req() request: Request,
  ) {
    assertReportAccess(context);
    const result = await this.history.availableMonths(context.organizationId);
    // Le navigateur ne lit pas `Content-Disposition` (CORS) : il reçoit ici
    // le même préfixe de nom de fichier que celui du téléchargement.
    return {
      ...result,
      filenamePrefix: reportFilenamePrefix(
        result.organizationSlug,
        localeFromRequest(request),
      ),
    };
  }

  @Get(':month/:format')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  async download(
    @Param('month') month: string,
    @Param('format') format: string,
    @CurrentOrganization() context: ResolvedOrganizationContext,
    @Res({ passthrough: true }) res: Response,
    @Req() request: Request,
  ): Promise<StreamableFile> {
    assertReportAccess(context);
    // 1-16G : libellés dans la langue demandée (`?lang=`, sinon
    // Accept-Language, sinon français) ; données et calculs identiques.
    const locale = localeFromRequest(request);
    if (format !== 'xlsx' && format !== 'pdf') {
      throw new BadRequestException({
        code: REPORT_FORMAT_INVALID,
        message: 'Format invalide.',
      });
    }
    const now = new Date();
    assertReportMonth(month, now);

    // Quota et simultanéité APRÈS les contrôles d'accès et de saisie : une
    // requête refusée ou invalide ne consomme rien.
    const slot = this.limiter.acquire(context.userId, context.organizationId);
    if (!slot.admitted) {
      res.setHeader('Retry-After', String(slot.retryAfterSeconds));
      res.setHeader('Cache-Control', 'no-store');
      const rateLimited = slot.code === REPORT_RATE_LIMITED;
      throw new HttpException(
        {
          code: slot.code,
          message: rateLimited
            ? `Trop de téléchargements d'historique en peu de temps. Réessayez dans ${Math.ceil(slot.retryAfterSeconds / 60)} min.`
            : "D'autres rapports sont en cours de préparation. Réessayez dans quelques secondes.",
          retryAfterSeconds: slot.retryAfterSeconds,
        },
        rateLimited
          ? HttpStatus.TOO_MANY_REQUESTS
          : HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    try {
      const history = await this.history.build(context, month, now);
      const labels = REPORT_LABELS[locale];
      let file: Buffer;
      try {
        file =
          format === 'xlsx'
            ? renderMonthlyHistoryXlsx(history, labels)
            : renderMonthlyHistoryPdf(history, labels);
      } catch (error) {
        if (error instanceof PdfUnsupportedTextError) {
          throw pdfUnsupportedException(error, locale);
        }
        throw error;
      }
      // Fichier entièrement construit en mémoire : la place est rendue dès
      // maintenant, l'envoi ne génère plus rien.
      return new StreamableFile(file, {
        type: REPORT_FORMATS[format],
        disposition: `attachment; filename="${reportFilename(history.organization.slug, month, format, locale)}"`,
        length: file.length,
      });
    } finally {
      slot.release();
    }
  }
}
