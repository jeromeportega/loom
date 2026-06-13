import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LessonStore } from '../state/LessonStore.js';
import type { AuditLog } from '../state/AuditLog.js';

export function applyAsPolicySuggestion(
  deps: { lessonStore: LessonStore; audit: AuditLog; db: Database.Database },
  lessonId: number,
  suggestion: string,
): { auditRef: string } {
  const auditRef = randomUUID();
  const run = deps.db.transaction(() => {
    // Mark first so the lesson update happens before the audit row is committed —
    // if markApplied throws the audit row is never written (no orphaned audit entry).
    deps.lessonStore.markApplied(lessonId, 'policy_suggestion', auditRef);
    deps.audit.record({
      action: 'policy_suggestion',
      detail: { lessonId, suggestion, auditRef },
    });
  });
  run();
  return { auditRef };
}
