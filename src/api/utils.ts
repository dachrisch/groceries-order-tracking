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

export const JWT_SECRET = process.env.JWT_SECRET || 'groceries-secret-key-123-change-me';

export function formatZodError(error: any) {
  return error.errors.map((e: any) => `${e.path.join('.')}: ${e.message}`).join(', ');
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
