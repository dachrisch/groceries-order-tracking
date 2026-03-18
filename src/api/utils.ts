import crypto from 'crypto';

if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET environment variable is not set. Using a fallback secret.');
}

export const JWT_SECRET = process.env.JWT_SECRET || 'groceries-secret-key-123-change-me-temporary';

export interface ApiRequest {
  userId: string;
}

export function formatZodError(error: any) {
  return error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
}
