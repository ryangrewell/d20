export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_INPUT',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

/** Structured error shared by the API and the client. Never carries secrets or private data. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const forbidden = (message = 'You do not have permission to do that.') => new AppError('FORBIDDEN', message);
/** Used for both "missing" and "exists but you cannot see it" so private objects are not disclosed. */
export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`);
export const conflict = (message: string, details?: Record<string, unknown>) => new AppError('CONFLICT', message, details);
export const invalid = (message: string, details?: Record<string, unknown>) => new AppError('INVALID_INPUT', message, details);
