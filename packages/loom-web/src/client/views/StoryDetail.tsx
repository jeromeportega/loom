import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useStory } from '../hooks/useStory';
import { statusVariant } from '../lib/statusVariant';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { apiPost } from '../lib/api';
import { queryKeys } from '../lib/queryKeys';
import type { SseOutputPayload } from '../../shared/types';

interface MutationState {
  pending: boolean;
  error: string | null;
}

const initMutation: MutationState = { pending: false, error: null };

export function StoryDetail() {
  const { slug = '', epicId = '', storyId = '' } = useParams<{
    slug: string;
    epicId: string;
    storyId: string;
  }>();
  const { data, isLoading, isError, error } = useStory(slug, epicId, storyId);
  const queryClient = useQueryClient();

  const [log, setLog] = useState('');
  const [sseError, setSseError] = useState(false);
  const [killState, setKillState] = useState<MutationState>(initMutation);
  const [stopState, setStopState] = useState<MutationState>(initMutation);
  const [retryState, setRetryState] = useState<MutationState>(initMutation);
  const [cleanRetryState, setCleanRetryState] = useState<MutationState>(initMutation);

  // Tracks the byte offset covered by the server's log_tail snapshot. SSE events
  // with from < tailLenRef.current overlap the already-fetched tail and are skipped.
  // Declared before the SSE effect so the tail effect (declared after) runs second
  // under React StrictMode double-invocation and wins.
  const tailLenRef = useRef(0);

  // SSE subscription — resets and reconnects whenever storyId changes.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    setLog('');
    tailLenRef.current = 0;
    setSseError(false);
    const es = new EventSource('/api/events');
    es.addEventListener('output', (e: MessageEvent) => {
      const payload: SseOutputPayload = JSON.parse(e.data);
      if (payload.story_id !== storyId) return;
      // Skip bytes whose offset falls within the range already covered by log_tail.
      if (payload.from < tailLenRef.current) return;
      setLog(prev => prev + payload.bytes);
    });
    es.onerror = () => { setSseError(true); };
    return () => { es.close(); };
  }, [storyId]);

  // When data.log_tail grows (initial load or post-mutation refetch), update the
  // offset floor and clear the SSE-accumulated log — those bytes are now in the tail.
  // Declared after the SSE effect so it runs second under StrictMode, ensuring
  // tailLenRef reflects the actual tail length after both effects fire.
  useEffect(() => {
    const newLen = data?.log_tail?.length ?? 0;
    if (newLen > tailLenRef.current) {
      tailLenRef.current = newLen;
      setLog('');
    }
  }, [data?.log_tail]);

  async function runMutation(
    path: string,
    body: unknown,
    setter: (s: MutationState) => void,
    queryKey?: ReadonlyArray<string>
  ) {
    setter({ pending: true, error: null });
    try {
      const res = await apiPost(path, body);
      if (res.ok) {
        // Clear SSE log proactively; the refetch will populate a fresh log_tail that
        // covers all bytes received so far, and the tail effect will update tailLenRef.
        setLog('');
        if (queryKey) {
          await queryClient.invalidateQueries({ queryKey });
        }
        setter({ pending: false, error: null });
      } else {
        setter({ pending: false, error: `Request failed (${res.status})` });
      }
    } catch (e) {
      setter({ pending: false, error: (e as Error).message });
    }
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-2" aria-busy="true" data-testid="story-detail-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
    );
  }

  if (isError) {
    const status = (error as { status?: number })?.status;
    if (status === 404) {
      return <p className="p-4" data-testid="story-not-found">Story not found.</p>;
    }
    return <p className="p-4 text-destructive">Failed to load story.</p>;
  }

  if (!data) return null;

  const storyKey = queryKeys.story(slug, epicId, storyId);
  const isRunning = data.status === 'running';
  const isFailed = data.status === 'failed';
  const combinedLog = (data.log_tail ?? '') + log;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold">{data.story_id}</h2>
        <Badge variant={statusVariant(data.status)}>{data.status}</Badge>
      </div>

      {(isRunning || isFailed) && (
        <div className="flex flex-wrap gap-2 mb-4">
          {isRunning && (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={stopState.pending}
                onClick={() => { void runMutation('/api/stop', undefined, setStopState, storyKey); }}
                data-testid="stop-btn"
              >
                {stopState.pending && (
                  <span className="mr-1 animate-spin inline-block" data-testid="stop-btn-spinner">⟳</span>
                )}
                Stop
              </Button>
              {stopState.error && (
                <p className="text-xs text-destructive" data-testid="stop-error">{stopState.error}</p>
              )}
            </div>
          )}
          {isRunning && data.worker_pid != null && (
            <div className="flex flex-col gap-1">
              <Button
                variant="destructive"
                size="sm"
                disabled={killState.pending}
                onClick={() => { void runMutation(`/api/agents/${data.id}/kill`, undefined, setKillState, storyKey); }}
                data-testid="kill-btn"
              >
                {killState.pending && (
                  <span className="mr-1 animate-spin inline-block" data-testid="kill-btn-spinner">⟳</span>
                )}
                Kill
              </Button>
              {killState.error && (
                <p className="text-xs text-destructive" data-testid="kill-error">{killState.error}</p>
              )}
            </div>
          )}
          {isFailed && (
            <>
              <div className="flex flex-col gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={retryState.pending}
                  onClick={() => { void runMutation(`/api/stories/${storyId}/retry`, undefined, setRetryState, storyKey); }}
                  data-testid="retry-btn"
                >
                  {retryState.pending && (
                    <span className="mr-1 animate-spin inline-block" data-testid="retry-btn-spinner">⟳</span>
                  )}
                  Retry
                </Button>
                {retryState.error && (
                  <p className="text-xs text-destructive" data-testid="retry-error">{retryState.error}</p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={cleanRetryState.pending}
                  onClick={() => { void runMutation(`/api/stories/${storyId}/retry`, { clean: true }, setCleanRetryState, storyKey); }}
                  data-testid="clean-retry-btn"
                >
                  {cleanRetryState.pending && (
                    <span className="mr-1 animate-spin inline-block" data-testid="clean-retry-btn-spinner">⟳</span>
                  )}
                  Clean-retry
                </Button>
                {cleanRetryState.error && (
                  <p className="text-xs text-destructive" data-testid="clean-retry-error">{cleanRetryState.error}</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      <Tabs defaultValue="summary">
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
        </TabsList>
        <TabsContent value="summary">
          <dl className="space-y-2 text-sm mt-2">
            <div>
              <dt className="text-muted-foreground">Epic</dt>
              <dd>{data.epic_id}</dd>
            </div>
            {data.started_at && (
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd data-testid="created-at">{data.started_at}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">Updated</dt>
              <dd data-testid="updated-at">{data.updated_at}</dd>
            </div>
            {data.branch_name && (
              <div>
                <dt className="text-muted-foreground">Branch</dt>
                <dd>{data.branch_name}</dd>
              </div>
            )}
            {data.worktree_path && (
              <div>
                <dt className="text-muted-foreground">Worktree</dt>
                <dd>{data.worktree_path}</dd>
              </div>
            )}
            {data.pr_url && data.pr_url.startsWith('https://') && (
              <div>
                <dt className="text-muted-foreground">PR</dt>
                <dd>
                  <a href={data.pr_url} className="underline text-primary">
                    {data.pr_url}
                  </a>
                </dd>
              </div>
            )}
            {data.model && (
              <div>
                <dt className="text-muted-foreground">Model</dt>
                <dd>{data.model}</dd>
              </div>
            )}
            {data.tokens_total != null && (
              <div>
                <dt className="text-muted-foreground">Tokens</dt>
                <dd>{data.tokens_total.toLocaleString()}</dd>
              </div>
            )}
            {data.cost_usd != null && (
              <div>
                <dt className="text-muted-foreground">Cost</dt>
                <dd>${data.cost_usd.toFixed(4)}</dd>
              </div>
            )}
          </dl>
        </TabsContent>
        <TabsContent value="log" forceMount>
          {sseError && (
            <p className="text-xs text-destructive mb-1" data-testid="sse-error">
              Live log disconnected — output may be incomplete.
            </p>
          )}
          <pre
            className="text-xs overflow-auto bg-muted p-3 rounded font-mono mt-2"
            data-testid="log-output"
          >
            {combinedLog || 'No log output yet.'}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
