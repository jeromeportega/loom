import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEpics } from '../hooks/useEpics';
import { useEpicArtifacts } from '../hooks/useEpicArtifacts';
import { useRepos } from '../hooks/useRepos';
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
  const { data: epicsData, isLoading: epicsLoading, isError: epicsError } = useEpics(slug);

  const epic = epicsData?.epics?.find((e) => e.id === epicId);
  const isPlanned = epic?.status === 'planned';

  const {
    data: artifacts,
    isLoading: artifactsLoading,
    isError: artifactsError,
  } = useEpicArtifacts(slug, epicId, isPlanned ?? false);

  // Resolve this repo's project ROOT so approve/reject target the RIGHT DB in the
  // federated view. Epic ids collide across repos, and without ?project= the
  // server falls back to the host project — mutating the wrong repo's epic.
  const { data: reposData } = useRepos();
  const projectRoot = reposData?.repos?.find((r) => r.slug === slug)?.root;
  const projectQuery = projectRoot ? `?project=${encodeURIComponent(projectRoot)}` : '';

  const [approveState, setApproveState] = useState<MutationState>({ pending: false, error: null });
  const [rejectState, setRejectState] = useState<MutationState>({ pending: false, error: null });
  const [rejectReason, setRejectReason] = useState('');

  async function handleApprove() {
    if (!projectRoot) {
      setApproveState({ pending: false, error: 'Resolving project — try again' });
      return;
    }
    setApproveState({ pending: true, error: null });
    try {
      const res = await apiPost(`/api/epics/${encodeURIComponent(epicId)}/approve${projectQuery}`);
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
    if (!projectRoot) {
      setRejectState({ pending: false, error: 'Resolving project — try again' });
      return;
    }
    setRejectState({ pending: true, error: null });
    try {
      // Thread the optional reason (matching `loom reject --reason`) so a plan
      // rejected from the dashboard records WHY in the audit trail. Omit the body
      // entirely when blank so the no-reason call stays a bare POST.
      const trimmed = rejectReason.trim();
      const path = `/api/epics/${encodeURIComponent(epicId)}/reject${projectQuery}`;
      const res = trimmed ? await apiPost(path, { reason: trimmed }) : await apiPost(path);
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

  if (epicsLoading) {
    return <div className="p-4 text-muted-foreground text-sm" data-testid="epics-loading">Loading…</div>;
  }

  if (epicsError) {
    return <div className="p-4 text-destructive text-sm" data-testid="epics-error">Failed to load epic.</div>;
  }

  return (
    <div className="p-4">
      {isPlanned && artifactsError && (
        <p className="text-destructive text-sm mb-4" data-testid="artifacts-error">
          Failed to load planning artifacts.
        </p>
      )}
      {isPlanned && artifactsLoading && (
        <p className="text-muted-foreground text-sm mb-4" data-testid="artifacts-loading">
          Loading planning artifacts…
        </p>
      )}
      {isPlanned && artifacts && <PlanningArtifactsPanel artifacts={artifacts} />}
      {isPlanned && (
        <div className="mb-6" data-testid="approve-reject-controls">
          <div className="flex gap-3">
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
          <textarea
            className="mt-3 w-full max-w-md rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
            rows={2}
            placeholder="Rejection reason (optional) — recorded in the audit log"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            disabled={rejectState.pending}
            data-testid="reject-reason-input"
          />
        </div>
      )}
      <StoryList />
    </div>
  );
}
