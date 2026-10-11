import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  NestInterceptor,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_SUPPORT_THROTTLER } from '../../support/support-rate-limiting';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { CurrentOrganization } from '../../auth/decorators/current-organization.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { OwnerOnly } from '../../auth/decorators/permissions.decorator';
import type { ResolvedOrganizationContext } from '../../organizations/organizations.service';
import { AllowInactiveSubscription } from '../subscription-access';
import {
  PAYMENT_READ_THROTTLER,
  PAYMENT_WEBHOOK_THROTTLER,
  PAYMENT_WRITE_THROTTLER,
  SubscriptionPaymentThrottlerGuard,
} from '../../common/subscription-payment-rate-limiting';
import {
  CreateSubscriptionPaymentDto,
  ListSubscriptionPaymentsQueryDto,
} from './dto/subscription-payment.dto';
import { unexpectedBody } from './payment-errors';
import {
  PaymentRequestContext,
  SubscriptionPaymentsService,
} from './subscription-payments.service';

/**
 * `Cache-Control: no-store` posé AVANT le handler : couvre aussi les
 * erreurs levées par le handler (le filtre global ne retire pas l'en-tête).
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

/** Autres fenêtres du `forRoot` unique, jamais évaluées ici. */
const OTHER_THROTTLERS = {
  'login-short': true,
  'login-long': true,
  'invitation-create': true,
  [PAYMENT_WEBHOOK_THROTTLER]: true,
  ...SKIP_SUPPORT_THROTTLER,
} as const;

const toContext = (
  organizationContext: ResolvedOrganizationContext,
): PaymentRequestContext => ({
  organizationId: organizationContext.organizationId,
  userId: organizationContext.userId,
});

/**
 * 1-14D.2B — Paiements d'abonnement de l'organisation COURANTE.
 *
 * - Propriétaire RÉEL uniquement : opération owner-only `billing.payment`
 *   (`PermissionGuard` exige `membership.role === owner`, jamais délégable,
 *   jamais `User.role`).
 * - JWT applicatif OU `subscription_limited` : exception commerciale
 *   `identity` limitée à ce contrôleur (matrice des routes mise à jour).
 *   Authentification, email vérifié, version de session, membership,
 *   suspension de l'organisation : toujours contrôlés par les gardes
 *   globaux (`JwtAuthGuard`, `OrganizationGuard`).
 * - Organisation et demandeur : contexte serveur uniquement. Corps
 *   strictement validé ; aucun montant, devise, statut, prestataire ou
 *   organisation accepté.
 */
@Controller('organizations/current/subscription/payments')
@AllowInactiveSubscription('identity')
@OwnerOnly('billing.payment')
@UseInterceptors(NoStoreInterceptor)
@UseGuards(SubscriptionPaymentThrottlerGuard)
export class SubscriptionPaymentsController {
  constructor(private readonly payments: SubscriptionPaymentsService) {}

  @Post()
  @SkipThrottle({ ...OTHER_THROTTLERS, [PAYMENT_READ_THROTTLER]: true })
  async create(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @CurrentUser() user: { name?: unknown; email?: unknown } | undefined,
    @Body() dto: CreateSubscriptionPaymentDto,
  ) {
    const { payment, replayed } = await this.payments.createPayment(
      toContext(organizationContext),
      {
        term: dto.term,
        payerPhone: dto.payerPhone ?? null,
        clientOperationId: dto.clientOperationId,
        // 1-21B : payeur = compte AUTHENTIFIÉ (e-mail vérifié), jamais le
        // corps ; transmis au seul prestataire qui l'exige.
        payer:
          typeof user?.email === 'string' && typeof user.name === 'string'
            ? { email: user.email, name: user.name }
            : undefined,
      },
    );
    return { ...payment, replayed };
  }

  /**
   * 1-21B — Moyen de paiement des nouvelles tentatives (page hébergée ou
   * numéro Mobile Money), sans aucun secret. Déclarée AVANT `:paymentId`.
   */
  @Get('capabilities')
  @SkipThrottle({ ...OTHER_THROTTLERS, [PAYMENT_WRITE_THROTTLER]: true })
  capabilities() {
    return this.payments.capabilities();
  }

  @Get()
  @SkipThrottle({ ...OTHER_THROTTLERS, [PAYMENT_WRITE_THROTTLER]: true })
  list(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Query() query: ListSubscriptionPaymentsQueryDto,
  ) {
    return this.payments.listPayments(toContext(organizationContext), {
      limit: query.limit,
      before: query.before,
    });
  }

  @Get(':paymentId')
  @SkipThrottle({ ...OTHER_THROTTLERS, [PAYMENT_WRITE_THROTTLER]: true })
  get(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Param('paymentId') paymentId: string,
  ) {
    return this.payments.getPayment(toContext(organizationContext), paymentId);
  }

  @Post(':paymentId/refresh')
  @HttpCode(200)
  @SkipThrottle({ ...OTHER_THROTTLERS, [PAYMENT_READ_THROTTLER]: true })
  refresh(
    @CurrentOrganization() organizationContext: ResolvedOrganizationContext,
    @Param('paymentId') paymentId: string,
    @Body() body: unknown,
  ) {
    // Corps vide STRICT : aucune donnée client n'entre dans la confirmation.
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== 'object' || Object.keys(body).length > 0)
    ) {
      throw unexpectedBody();
    }
    return this.payments.refreshPayment(
      toContext(organizationContext),
      paymentId,
    );
  }
}
