export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'INTEGRITY_ERROR';

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly status: number;
  public readonly details?: Readonly<Record<string, unknown>>;

  public constructor(
    code: DomainErrorCode,
    message: string,
    options: { status?: number; details?: Readonly<Record<string, unknown>>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DomainError';
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    if (options.details !== undefined) this.details = options.details;
  }
}

function defaultStatus(code: DomainErrorCode): number {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'IDEMPOTENCY_KEY_REUSED':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    case 'INTEGRITY_ERROR':
      return 500;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
