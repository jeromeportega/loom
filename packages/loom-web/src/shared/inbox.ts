/**
 * Inbox types — shared between server and frontend.
 * Owner: story-003-004
 */

export type InboxType = 'plan_approval' | 'checkpoint_resume' | 'escalation';

export interface InboxEntry {
  type: InboxType;
  project_root: string;
  project: string;
  epic_id: string;
  title: string;
  story_id: string | null; // set for checkpoint_resume / escalation
  age_ms: number;           // now − decision-relevant timestamp
}
