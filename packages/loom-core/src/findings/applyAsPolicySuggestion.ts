import { randomUUID } from 'node:crypto';
import type { LessonStore } from '../state/LessonStore.js';
import type { AuditLog } from '../state/AuditLog.js';

export function applyAsPolicySuggestion(
  deps: { lessonStore: LessonStore; audit: AuditLog },
  lessonId: number,
  suggestion: string,
): { auditRef: string } {
  const auditRef = randomUUID();
  deps.audit.record({
    action: 'policy_suggestion',
    detail: { lessonId, suggestion, auditRef },
  });
  deps.lessonStore.markApplied(lessonId, 'policy_suggestion', auditRef);
  return { auditRef };
}
