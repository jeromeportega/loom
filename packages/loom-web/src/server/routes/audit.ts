import type { Express, NextFunction, Request, Response } from 'express';
import { AuditLog } from '@loom-ai/core';

interface AuditVerifyDeps {
  auditLog: AuditLog;
}

export function registerAuditVerifyRoute(app: Express, deps: AuditVerifyDeps): void {
  app.get('/api/audit/verify', (_req: Request, res: Response, next: NextFunction): void => {
    try {
      res.json(deps.auditLog.verifyChain());
    } catch (err) {
      next(err);
    }
  });
}
