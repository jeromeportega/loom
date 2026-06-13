import { EpicStore, AuditLog } from '../../state/index.js';
import type { AutonomyLevel } from '../../types.js';

export class EpicNotFoundError extends Error {
  constructor(epicId: string) {
    super(`Epic "${epicId}" not found`);
    this.name = 'EpicNotFoundError';
  }
}

/**
 * Sets the autonomy level for an epic and writes an `autonomy_set` audit row.
 * Called by both the web route (actor: 'web') and the MCP tool (actor: 'mcp')
 * so both surfaces produce identical persisted state and audit rows.
 */
export function setEpicAutonomy(
  deps: { epicStore: EpicStore; auditLog: AuditLog },
  epicId: string,
  level: AutonomyLevel,
  actor: string
): { id: string; autonomy_level: AutonomyLevel } {
  const { epicStore, auditLog } = deps;
  const epic = epicStore.get(epicId);
  if (!epic) throw new EpicNotFoundError(epicId);
  epicStore.setAutonomy(epicId, level);
  auditLog.record({ action: 'autonomy_set', command: epicId, detail: { level, actor } });
  return { id: epicId, autonomy_level: level };
}
