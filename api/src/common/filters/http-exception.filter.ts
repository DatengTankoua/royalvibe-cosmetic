import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { NO_STORE_ERROR_CODES } from '../../subscriptions/subscription-access';
import {
  PAYMENT_WEBHOOK_ERROR_CODE_PREFIX,
  genericPaymentWebhookErrorMessage,
  isPaymentWebhookPath,
} from '../../subscriptions/payments/payment-webhook-paths';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    const isObject = typeof body === 'object' && body !== null;
    const message = isObject
      ? ((body as { message?: string | string[] }).message ?? exception.message)
      : body;

    // Preserve extra fields from structured bodies (e.g. { message, existing })
    const extra = isObject
      ? Object.fromEntries(
          Object.entries(body as Record<string, unknown>).filter(
            ([k]) => k !== 'message',
          ),
        )
      : {};

    // 1-14C.1 : refus commerciaux (dont le jeton limité) jamais mis en cache.
    const code = (extra as { code?: unknown }).code;
    if (typeof code === 'string' && NO_STORE_ERROR_CODES.has(code)) {
      response.setHeader('Cache-Control', 'no-store');
    }

    // 1-14D.2F : notifications de paiement (toute casse, comme le routeur) →
    // `no-store`, chemin seul (jamais la query : signature, téléphone, URL de
    // redirection d'un callback GET), et message repris SEULEMENT s'il porte
    // un code propre au webhook ; sinon message générique (le message d'une
    // erreur du parseur JSON cite un extrait du corps reçu).
    if (
      typeof request.path === 'string' &&
      isPaymentWebhookPath(request.path)
    ) {
      response.setHeader('Cache-Control', 'no-store');
      const own =
        typeof code === 'string' &&
        code.startsWith(PAYMENT_WEBHOOK_ERROR_CODE_PREFIX);
      response.status(status).json({
        statusCode: status,
        error: HttpStatus[status] ?? 'Error',
        ...(own
          ? { message, code }
          : { message: genericPaymentWebhookErrorMessage(status) }),
        path: request.path,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    response.status(status).json({
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      ...extra,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
