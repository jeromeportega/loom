import type { Express, Request, RequestHandler, Response } from 'express';
import { AuditLog } from '@loom-ai/core';

interface AuditVerifyDeps {
  auditLog: AuditLog;
  /** Auth middleware applied inline so the contract survives route moves or sub-router refactors. */
  authMiddleware: RequestHandler;
}

export function registerAuditVerifyRoute(app: Express, deps: AuditVerifyDeps): void {
  app.get('/api/audit/verify', deps.authMiddleware, (_req: Request, res: Response): void => {
    try {
      res.json(deps.auditLog.verifyChain());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}
