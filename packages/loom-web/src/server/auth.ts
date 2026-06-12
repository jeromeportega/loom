import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Generates a per-launch random token. The launching terminal prints it; the
 * frontend reads it from the URL fragment on first load and includes it on
 * every request. Defends localhost against rogue same-machine processes
 * that might opportunistically poke `localhost:8765/api/*`.
 */
export function newToken(): string {
  return crypto.randomBytes(24).toString('hex');
}

export interface AuthOptions {
  /** The expected token. Requests without it are 401. */
  token: string;
}

/**
 * Middleware: requires every request to carry the token, either as the
 * `x-loom-token` header (preferred, used by frontend) or `?token=` query
 * (for hand-testing with curl). Constant-time comparison so a leaked
 * latency cannot be used to recover the token.
 */
export function requireToken(opts: AuthOptions) {
  const expected = Buffer.from(opts.token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented =
      (req.header('x-loom-token') ?? '') ||
      (typeof req.query.token === 'string' ? req.query.token : '');
    const provided = Buffer.from(presented);
    if (
      provided.length !== expected.length ||
      !crypto.timingSafeEqual(provided, expected)
    ) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
