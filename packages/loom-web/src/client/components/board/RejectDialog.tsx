import { useState } from 'react';
import { Button } from '../ui/button';
import type { FleetCard } from '../../../shared/fleet';

export interface RejectDialogProps {
  card: FleetCard;
  onConfirm(reason: string): void;
  onCancel(): void;
}

/**
 * Minimal reason-capture modal for rejecting a planned epic. The reason is
 * optional and, when given, recorded to the audit log (parity with
 * `loom reject --reason`).
 */
export function RejectDialog({ card, onConfirm, onCancel }: RejectDialogProps) {
  const [reason, setReason] = useState('');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Reject ${card.epic_id}`}
        className="w-full max-w-sm rounded-lg border bg-card p-4 text-card-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-semibold">Reject {card.epic_id}?</h2>
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{card.title}</p>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional) — recorded in the audit log"
          className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" className="h-8" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" className="h-8" onClick={() => onConfirm(reason)}>
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}
