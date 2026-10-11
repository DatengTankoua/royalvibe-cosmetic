import { Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { SKIP_SUPPORT_THROTTLER } from '../../../support/support-rate-limiting';
import { Public } from '../../../auth/decorators/public.decorator';
import {
  PAYMENT_READ_THROTTLER,
  PAYMENT_WRITE_THROTTLER,
  PaymentWebhookThrottlerGuard,
} from '../../../common/subscription-payment-rate-limiting';
import { PAYMENT_WEBHOOK_PATH_PREFIX } from '../payment-webhook-paths';
import {
  SasPayWebhookResponse,
  SasPayWebhookService,
} from './saspay-webhook.service';

export const SASPAY_WEBHOOK_ROUTE = `${PAYMENT_WEBHOOK_PATH_PREFIX}saspay`;

/**
 * 1-21B — `POST /payments/webhooks/saspay` (public, limité comme le webhook
 * CamPay). Corps BRUT transmis tel quel à la vérification de signature ;
 * réponse `no-store`, jamais de donnée reçue renvoyée.
 */
@Controller(SASPAY_WEBHOOK_ROUTE.slice(1))
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
export class SasPayWebhookController {
  constructor(private readonly webhook: SasPayWebhookService) {}

  @Post()
  async notify(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await this.webhook.handle({
      rawBody: req.rawBody,
      contentType: req.headers['content-type'],
      signature: req.headers['x-webhook-signature'],
      timestamp: req.headers['x-webhook-timestamp'],
      eventHeader: req.headers['x-webhook-event'],
    });
    this.send(res, outcome);
  }

  private send(res: Response, outcome: SasPayWebhookResponse): void {
    res.setHeader('Cache-Control', 'no-store');
    if (outcome.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(outcome.retryAfterSeconds));
    }
    res.status(outcome.status).json(outcome.body);
  }
}
