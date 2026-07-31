import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { classifyJsonBodyClientError } from './json-body.js';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const notFoundHandler: RequestHandler = (_request, _response, next) => {
  next(new HttpError(404, 'not_found', 'Route not found.'));
};

export const requireApiJsonBody: RequestHandler = (request, _response, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method) || request.is('application/json')) {
    next();
    return;
  }
  next(new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.'));
};

function isDomainError(error: unknown): error is {
  code: string;
  message: string;
  status?: number;
  details?: unknown;
} {
  if (!(error instanceof Error)) return false;
  const value = error as Error & { code?: unknown; status?: unknown };
  return (
    typeof value.code === 'string' &&
    (value.status === undefined || typeof value.status === 'number')
  );
}

function statusForDomainCode(code: string): number {
  switch (code) {
    case 'NOT_FOUND':
    case 'not_found':
      return 404;
    case 'CONFLICT':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'MUTATION_ID_CONFLICT':
    case 'REVERT_CONFLICT':
    case 'conflict':
      return 409;
    case 'UNAUTHORIZED':
    case 'unauthorized':
      return 401;
    case 'FORBIDDEN':
    case 'forbidden':
      return 403;
    case 'RATE_LIMITED':
    case 'rate_limited':
      return 429;
    default:
      return 400;
  }
}

function restCodeForDomainCode(code: string): string {
  return code === 'IDEMPOTENCY_KEY_REUSED' ? 'mutation_id_reused' : code.toLowerCase();
}

export const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  void next;
  if (response.headersSent) return;

  const bodyError = classifyJsonBodyClientError(error);
  if (bodyError) {
    const bodyErrorResponse = {
      malformed: {
        code: 'validation_error',
        message: 'Request body contains malformed JSON.',
      },
      payload_too_large: {
        code: 'payload_too_large',
        message: 'Request body exceeds the 1 MiB limit.',
      },
      unsupported_encoding: {
        code: 'unsupported_media_type',
        message: 'Request body encoding is not supported.',
      },
      invalid_body: {
        code: 'validation_error',
        message: 'Request body could not be read.',
      },
    }[bodyError.kind];
    response.status(bodyError.status).json({
      error: {
        code: bodyErrorResponse.code,
        message: bodyErrorResponse.message,
      },
    });
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed.',
        details: error.issues,
      },
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  if (isDomainError(error)) {
    response.status(error.status ?? statusForDomainCode(error.code)).json({
      error: {
        code: restCodeForDomainCode(error.code),
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  response.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error.' },
  });
};
