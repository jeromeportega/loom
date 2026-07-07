import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEpics } from '../hooks/useEpics';
import { useEpicArtifacts } from '../hooks/useEpicArtifacts';
import { apiPost } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import { Button } from '../components/ui/button';
import { StoryList } from './StoryList';
import type { PlanningArtifacts } from '../../shared/types';

interface MutationState {
  pending: boolean;
  error: string | null;
}

function PlanningArtifactsPanel({ artifacts }: { artifacts: PlanningArtifacts }) {
  return (
    <div className="space-y-4 mb-6" data-testid="planning-artifacts-panel">
      <div>
        <h3 className="text-sm font-medium mb-1">Brief</h3>
        <pre
          className="text-xs overflow-auto bg-muted p-3 rounded font-mono whitespace-pre-wrap"
          data-testid="artifact-brief"
        >
          {artifacts.brief ?? '(not available)'}
        </pre>
      </div>
      <div>
        <h3 className="text-sm font-medium mb-1">PRD</h3>
        <pre
          className="text-xs overflow-auto bg-muted p-3 rounded font-mono whitespace-pre-wrap"
          data-testid="artifact-prd"
        >
          {artifacts.prd ?? '(not available)'}
        </pre>
      </div>
      <div>
        <h3 className="text-sm font-medium mb-1">Architecture</h3>
        <pre
          className="text-xs overflow-auto bg-muted p-3 rounded font-mono whitespace-pre-wrap"
          data-testid="artifact-architecture"
        >
          {artifacts.architecture ?? '(not available)'}
        </pre>
      </div>
      <div>
        <h3 className="text-sm font-medium mb-1">Epic YAML</h3>
        <pre
          className="text-xs overflow-auto bg-muted p-3 rounded font-mono whitespace-pre-wrap"
          data-testid="artifact-yaml"
        >
          {artifacts.epic_yaml ?? '(not available)'}
        </pre>
      </div>
    </div>
  );
}

export function EpicDetail() {
  const { slug = '', epicId = '' } = useParams<{ slug: string; epicId: string }>();
  const queryClient = useQueryClient();
  const { data: epicsData } = useEpics(slug);

  const epic = epicsData?.epics?.find((e) => e.id === epicId);
  const isPlanned = epic?.status === 'planned';

  const { data: artifacts } = useEpicArtifacts(slug, epicId, isPlanned ?? false);

  const [approveState, setApproveState] = useState<MutationState>({ pending: false, error: null });
  const [rejectState, setRejectState] = useState<MutationState>({ pending: false, error: null });

  async function handleApprove() {
    setApproveState({ pending: true, error: null });
    try {
      const res = await apiPost(`/api/epics/${encodeURIComponent(epicId)}/approve`);
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.epics(slug) });
        setApproveState({ pending: false, error: null });
      } else {
        setApproveState({ pending: false, error: `Request failed (${res.status})` });
      }
    } catch {
      setApproveState({ pending: false, error: 'Network error' });
    }
  }

  async function handleReject() {
    setRejectState({ pending: true, error: null });
    try {
      const res = await apiPost(`/api/epics/${encodeURIComponent(epicId)}/reject`);
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.epics(slug) });
        setRejectState({ pending: false, error: null });
      } else {
        setRejectState({ pending: false, error: `Request failed (${res.status})` });
      }
    } catch {
      setRejectState({ pending: false, error: 'Network error' });
    }
  }

  return (
    <div className="p-4">
      {isPlanned && artifacts && <PlanningArtifactsPanel artifacts={artifacts} />}
      {isPlanned && (
        <div className="flex gap-3 mb-6" data-testid="approve-reject-controls">
          <div>
            <Button
              onClick={handleApprove}
              disabled={approveState.pending}
              data-testid="approve-button"
            >
              {approveState.pending && (
                <span className="mr-1 animate-spin" data-testid="approve-spinner" aria-hidden>
                  ⟳
                </span>
              )}
              Approve
            </Button>
            {approveState.error && (
              <p className="text-destructive text-sm mt-1" data-testid="approve-error">
                {approveState.error}
              </p>
            )}
          </div>
          <div>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={rejectState.pending}
              data-testid="reject-button"
            >
              {rejectState.pending && (
                <span className="mr-1 animate-spin" data-testid="reject-spinner" aria-hidden>
                  ⟳
                </span>
              )}
              Reject
            </Button>
            {rejectState.error && (
              <p className="text-destructive text-sm mt-1" data-testid="reject-error">
                {rejectState.error}
              </p>
            )}
          </div>
        </div>
      )}
      <StoryList />
    </div>
  );
}
