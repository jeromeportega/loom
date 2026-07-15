import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { AuditLog } from '@loom-ai/core';

interface AuditVerifyDeps {
  auditLog: AuditLog;
  /** Auth middleware applied inline so the contract survives route moves or sub-router refactors. */
  authMiddleware: RequestHandler;
}

export function registerAuditVerifyRoute(app: Express, deps: AuditVerifyDeps): void {
  app.get('/api/audit/verify', deps.authMiddleware, (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json(deps.auditLog.verifyChain());
    } catch (err) {
      next(err);
    }
  });
}
