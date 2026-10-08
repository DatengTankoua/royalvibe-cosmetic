import { Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { SKIP_SUPPORT_THROTTLER } from '../../../support/support-rate-limiting';
import type { Request, Response } from 'express';
import { Public } from '../../../auth/decorators/public.decorator';
import {
  PAYMENT_READ_THROTTLER,
  PAYMENT_WRITE_THROTTLER,
  PaymentWebhookThrottlerGuard,
} from '../../../common/subscription-payment-rate-limiting';
import { PAYMENT_WEBHOOK_PATH_PREFIX } from '../payment-webhook-paths';
import {
  CamPayWebhookResponse,
  CamPayWebhookService,
} from './campay-webhook.service';

export const CAMPAY_WEBHOOK_ROUTE = `${PAYMENT_WEBHOOK_PATH_PREFIX}campay`;

/**
 * 1-14D.2F — Point de notification CamPay (GET ou POST, au choix de
 * l'application CamPay). DÉSACTIVÉ par défaut : 503 sans lecture des
 * paramètres, sans base ni prestataire (voir `campay-webhook.config.ts`).
 *
 * - `@Public()` : aucun JWT applicatif (les gardes globaux s'effacent) ;
 *   l'authentification est la signature HS256 vérifiée par le service ;
 * - limitation dédiée `payment-webhook` (tracker `req.ip` calculé par
 *   Express), évaluée en premier ; autres fenêtres explicitement exclues ;
 * - réponses génériques `no-store`, sans aucune donnée reçue.
 */
@Controller(CAMPAY_WEBHOOK_ROUTE.slice(1))
@Public()
@UseGuards(PaymentWebhookThrottlerGuard)
@SkipThrottle({
  'login-short': true,
  'login-long': true,
  'invitation-create': true,
  [PAYMENT_WRITE_THROTTLER]: true,
  [PAYMENT_READ_THROTTLER]: true,
  ...SKIP_SUPPORT_THROTTLER,
})
export class CamPayWebhookController {
  constructor(private readonly webhook: CamPayWebhookService) {}

  @Get()
  async notifyGet(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    this.send(res, await this.webhook.handle(this.toInput('GET', req)));
  }

  @Post()
  async notifyPost(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    this.send(res, await this.webhook.handle(this.toInput('POST', req)));
  }

  private toInput(method: 'GET' | 'POST', req: RawBodyRequest<Request>) {
    return {
      method,
      urlLength: req.originalUrl.length,
      query: req.query as unknown,
      body: req.body as unknown,
      rawBody: req.rawBody,
      contentType: req.headers['content-type'],
    };
  }

  private send(res: Response, outcome: CamPayWebhookResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    if (outcome.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    }
    res.status(outcome.status).json(outcome.body);
  }
}
