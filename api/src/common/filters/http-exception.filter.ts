import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { NO_STORE_ERROR_CODES } from '../../subscriptions/subscription-access';

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
