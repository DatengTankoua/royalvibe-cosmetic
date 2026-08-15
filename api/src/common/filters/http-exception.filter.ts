import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

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
