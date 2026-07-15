import type { Express, Request, Response } from 'express';
import { AuditLog } from '@loom-ai/core';

interface AuditVerifyDeps {
  auditLog: AuditLog;
}

export function registerAuditVerifyRoute(app: Express, deps: AuditVerifyDeps): void {
  app.get('/api/audit/verify', (_req: Request, res: Response): void => {
    res.json(deps.auditLog.verifyChain());
  });
}
