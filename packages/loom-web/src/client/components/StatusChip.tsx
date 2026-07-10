import * as React from 'react';
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';

export type CanonicalStatus =
  | 'running'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'pending'
  | 'queued'
  | 'pr_open'
  | 'rejected';

export const STATUS_CLASSES: Record<CanonicalStatus, string> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  blocked: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  failed:  'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  done:    'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  queued:  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  pr_open: 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200',
  rejected:'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
};

const UNKNOWN_CLASSES = 'bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-500';

/**
 * Maps loom's real epic/story status vocabulary (types.ts `EpicStatus` +
 * `AgentStatus`) onto the canonical visual buckets. Without this the board's
 * most common live states — `in_progress`, `pr_open`, `finalizing` — fall
 * through to the gray "unknown" treatment with no spinner, which defeats the
 * point of a live status board. The raw status is still shown as the label;
 * only the color + spinner are canonicalized.
 */
const STATUS_ALIASES: Record<string, CanonicalStatus> = {
  // actively doing work → running (blue + spinner)
  running: 'running',
  in_progress: 'running',
  dispatching: 'running',
  planning: 'running',
  integrating: 'running',
  finalizing: 'running',
  // waiting for the next step → pending (neutral)
  pending: 'pending',
  planned: 'pending',
  approved: 'pending',
  staging: 'pending',
  publish_pending: 'pending',
  queued: 'queued',
  // distinct terminal / review states
  done: 'done',
  failed: 'failed',
  blocked: 'blocked',
  rejected: 'rejected',
  pr_open: 'pr_open',
};

function toCanonical(raw: string): CanonicalStatus | null {
  if (raw in STATUS_ALIASES) return STATUS_ALIASES[raw];
  if (Object.hasOwn(STATUS_CLASSES, raw)) return raw as CanonicalStatus;
  return null;
}

export type StatusChipProps = {
  status: CanonicalStatus | string;
  className?: string;
};

export function StatusChip({ status, className }: StatusChipProps): JSX.Element {
  const canonical = toCanonical(status);
  const colorClasses = canonical ? STATUS_CLASSES[canonical] : UNKNOWN_CLASSES;

  return (
    <Badge
      className={cn('border-transparent font-medium', colorClasses, className)}
    >
      {canonical === 'running' && (
        <svg
          aria-hidden="true"
          className="mr-1 h-3 w-3 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {status}
    </Badge>
  );
}
