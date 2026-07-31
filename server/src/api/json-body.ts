export type JsonBodyClientError =
  | { kind: 'malformed'; status: 400 }
  | { kind: 'payload_too_large'; status: 413 }
  | { kind: 'unsupported_encoding'; status: 415 }
  | { kind: 'invalid_body'; status: 400 };

/** Recognize only documented body-parser client failures; internal faults stay 500s. */
export function classifyJsonBodyClientError(error: unknown): JsonBodyClientError | null {
  if (!(error instanceof Error)) return null;
  const value = error as Error & { status?: unknown; type?: unknown };
  if (typeof value.type !== 'string' || typeof value.status !== 'number') return null;

  switch (value.type) {
    case 'entity.parse.failed':
      return value.status === 400 ? { kind: 'malformed', status: 400 } : null;
    case 'entity.too.large':
      return value.status === 413 ? { kind: 'payload_too_large', status: 413 } : null;
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return value.status === 415 ? { kind: 'unsupported_encoding', status: 415 } : null;
    case 'request.aborted':
    case 'request.size.invalid':
      return value.status === 400 ? { kind: 'invalid_body', status: 400 } : null;
    default:
      return null;
  }
}
