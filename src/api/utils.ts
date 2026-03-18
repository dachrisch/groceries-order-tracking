import crypto from 'crypto';

export const JWT_SECRET = process.env.JWT_SECRET || 'groceries-secret-key-123-change-me';

export interface ApiRequest {
  userId: string;
}

export function formatZodError(error: any) {
  return error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
}
