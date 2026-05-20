import { Request, Response, NextFunction } from 'express';

// Extend Express Request type globally — avoids (req as any) in every controller
declare global {
  namespace Express {
    interface Request {
      userId: string;
      derivedKey?: Buffer;
    }
  }
}

const _JWT_SECRET = process.env.JWT_SECRET;
const _CSRF_SECRET = process.env.CSRF_SECRET;

if (!_JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: JWT_SECRET environment variable is not set');
}

if (!_CSRF_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: CSRF_SECRET environment variable is not set');
}

export const JWT_SECRET = _JWT_SECRET || 'groceries-secret-key-development-only';
export const CSRF_SECRET = _CSRF_SECRET || 'groceries-csrf-secret-development-only';



export function formatZodError(error: { issues: Array<{ path: PropertyKey[], message: string }> }) {
  return error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
}

/**
 * Middleware that reads the `dkey` httpOnly cookie and attaches the
 * decoded Buffer to req.derivedKey. If the cookie is missing, req.derivedKey
 * is undefined (routes that need it should check explicitly).
 */
export function derivedKeyMiddleware(req: Request, _res: Response, next: NextFunction) {
  const dkeyCookie = req.cookies.dkey as string | undefined;
  if (dkeyCookie) {
    try {
      req.derivedKey = Buffer.from(dkeyCookie, 'base64');
    } catch {
      // Invalid cookie — just leave derivedKey undefined
    }
  }
  next();
}
