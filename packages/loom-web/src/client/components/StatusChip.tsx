import * as React from 'react';
import { Badge } from './ui/badge';
import { cn } from '@/lib/utils';

export type CanonicalStatus =
  | 'running'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'pending'
  | 'queued';

export const STATUS_CLASSES: Record<CanonicalStatus, string> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  blocked: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  failed:  'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  done:    'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  pending: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  queued:  'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const UNKNOWN_CLASSES = 'bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-500';

export type StatusChipProps = {
  status: CanonicalStatus | string;
  className?: string;
};

export function StatusChip({ status, className }: StatusChipProps): JSX.Element {
  const isCanonical = status in STATUS_CLASSES;
  const colorClasses = isCanonical
    ? STATUS_CLASSES[status as CanonicalStatus]
    : UNKNOWN_CLASSES;

  return (
    <Badge
      className={cn('border-transparent font-medium', colorClasses, className)}
    >
      {status === 'running' && (
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
