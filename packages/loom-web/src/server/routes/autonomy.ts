import type { Express, Request, Response } from 'express';
import {
  EpicStore,
  AuditLog,
  AutonomyLevelSchema,
  setEpicAutonomy,
  EpicNotFoundError,
} from '@loom-ai/core';

/** Minimal subset of RouteDeps needed by this module. Structurally compatible
 *  with the full RouteDeps that story-003-006 will pass at mount time. */
interface AutonomyDeps {
  epicStore: EpicStore;
  auditLog: AuditLog;
}

export function registerAutonomyRoutes(app: Express, deps: AutonomyDeps): void {
  app.post('/api/epics/:id/autonomy', (req: Request, res: Response): void => {
    const parse = AutonomyLevelSchema.safeParse(req.body?.level);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid level; must be one of: full-auto, checkpoint, manual' });
      return;
    }
    try {
      const result = setEpicAutonomy(deps, req.params.id, parse.data, 'web');
      res.json(result);
    } catch (err) {
      if (err instanceof EpicNotFoundError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
