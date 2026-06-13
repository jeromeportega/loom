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

export interface AccessGuardOptions {
  token: string;
  readOnly: boolean;
}

/**
 * Single centralized access guard for all /api/* routes.
 *
 * readOnly=false (default): token required on every request — byte-identical
 * to requireToken (401 on failure). This is the only auth path in the server.
 *
 * readOnly=true: GET and HEAD pass without a token (public read access); any
 * other method requires the write token (403 on failure, not 401, to avoid
 * browser credential prompts).
 *
 * Token comparison uses crypto.timingSafeEqual — a wrong-length token returns
 * false rather than throwing, preventing length-leak timing side-channels.
 *
 * CLASSIFICATION INVARIANT: correctness depends on every mutation being a
 * non-GET verb. The enumerated-route test in access-guard.test.ts is the
 * load-bearing check — a misclassified route (e.g. a GET that mutates) will
 * pass read-only tokenlessly and the test will NOT fail. Add an explicit
 * route-shape assertion if that invariant matters to you.
 */
export function accessGuard(opts: AccessGuardOptions) {
  const expected = Buffer.from(opts.token);
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented =
      (req.header('x-loom-token') ?? '') ||
      (typeof req.query.token === 'string' ? req.query.token : '');
    const provided = Buffer.from(presented);
    const tokenValid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(provided, expected);

    if (opts.readOnly) {
      const method = req.method.toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        next();
        return;
      }
      if (!tokenValid) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      next();
    } else {
      if (!tokenValid) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
    }
  };
}
