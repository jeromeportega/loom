import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useStory } from '../hooks/useStory';
import { statusVariant } from '../lib/statusVariant';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { apiPost, apiFetch, eventSourceUrl } from '../lib/api';
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

  // baseLog: the full durable log fetched on view-enter (the SSE de-dup anchor).
  // liveLog: bytes appended by the SSE stream since that anchor.
  const [baseLog, setBaseLog] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState('');
  const [sseError, setSseError] = useState(false);
  const [killState, setKillState] = useState<MutationState>(initMutation);
  const [stopState, setStopState] = useState<MutationState>(initMutation);
  const [retryState, setRetryState] = useState<MutationState>(initMutation);
  const [cleanRetryState, setCleanRetryState] = useState<MutationState>(initMutation);

  // Absolute durable-byte offset covered by baseLog + liveLog. The server keys
  // SSE `output` events to an absolute `from` offset (agents.log_bytes), so the
  // de-dup floor MUST be an absolute byte length — anchored to X-Log-Length from
  // GET /api/agents/:id/log — not the rolling, char-counted log_tail window.
  const anchorRef = useRef(0);
  // The story that anchorRef/baseLog currently describe. On a story→story change
  // (same component instance) we must reset both, else B inherits A's byte floor
  // and drops its early output. Kept out of the effect's status/id re-runs so a
  // same-story status change doesn't wipe the log to a placeholder (flicker).
  const anchorStoryRef = useRef(storyId);

  // Live log. On view-enter (or story/status/agent change) fetch the full durable
  // log and anchor the SSE de-dup floor to its X-Log-Length. Then, for non-terminal
  // stories, open an *authenticated* SSE stream (token in the URL — EventSource
  // can't send headers) and append incremental appends keyed to their absolute
  // `from` offset. Fetching the full log also gives terminal stories their complete
  // output instead of the truncated log_tail window.
  useEffect(() => {
    const agentId = data?.id;
    if (!agentId) return;
    let cancelled = false;

    if (anchorStoryRef.current !== storyId) {
      // New story in the same instance — discard the previous story's anchor/base.
      anchorStoryRef.current = storyId;
      anchorRef.current = 0;
      setBaseLog(null);
    }
    setLiveLog('');
    void apiFetch(`/api/agents/${encodeURIComponent(agentId)}/log`)
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const text = await res.text();
        if (cancelled) return;
        const hdr = parseInt(res.headers.get('X-Log-Length') ?? '', 10);
        const absoluteLen = Number.isFinite(hdr)
          ? hdr
          : new TextEncoder().encode(text).length;
        // Never rewind: if SSE events already advanced the floor past this
        // snapshot (the server guarantees a ~500ms floor before the first
        // output, so this is defensive), keep the further offset.
        anchorRef.current = Math.max(anchorRef.current, absoluteLen);
        setBaseLog(text);
      })
      .catch(() => { /* SSE still streams; display falls back to log_tail */ });

    const terminal = data?.status === 'done' || data?.status === 'failed';
    if (terminal || typeof EventSource === 'undefined') {
      // Terminal (or no SSE support): no live stream. Clear any stale disconnect
      // banner left over from the running phase.
      setSseError(false);
      return () => { cancelled = true; };
    }

    setSseError(false);
    const es = new EventSource(eventSourceUrl('/api/events'));
    es.addEventListener('output', (e: MessageEvent) => {
      let payload: SseOutputPayload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (payload.story_id !== storyId) return;
      const floor = anchorRef.current;
      // Entirely covered by the fetched base log — drop.
      if (payload.from + payload.byteLength <= floor) return;
      if (payload.from >= floor) {
        // Contiguous append (from === floor) or ahead of it.
        setLiveLog(prev => prev + payload.bytes);
      } else {
        // Partial overlap — drop the covered byte-prefix, keep the new suffix.
        // Slice on a byte boundary (UTF-8 safe): from/byteLength are byte counts.
        const skip = floor - payload.from;
        const buf = new TextEncoder().encode(payload.bytes);
        setLiveLog(prev => prev + new TextDecoder().decode(buf.subarray(skip)));
      }
      anchorRef.current = payload.from + payload.byteLength;
    });
    es.onerror = () => { setSseError(true); };
    es.addEventListener('open', () => { setSseError(false); });
    return () => { cancelled = true; es.close(); };
  }, [storyId, data?.status, data?.id]);

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
        // The invalidate refetches the story; its status change re-runs the log
        // effect, which re-anchors baseLog and resets liveLog. No manual clear.
        if (queryKey) {
          await queryClient.invalidateQueries({ queryKey });
        }
        setter({ pending: false, error: null });
      } else {
        setter({ pending: false, error: `Request failed (${res.status})` });
      }
    } catch (e) {
      setter({ pending: false, error: e instanceof Error ? e.message : String(e) });
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
  const storiesKey = queryKeys.stories(slug, epicId);
  const isRunning = data.status === 'running';
  // Retry / Clean-retry apply to any story the server will re-dispatch — failed
  // OR blocked (StoryRetryService refuses only a still-running story). The pre-
  // React UI offered these on both; dropping 'blocked' left escalated stories
  // with no controls at all.
  const isRetryable = data.status === 'failed' || data.status === 'blocked';
  // Prefer the authoritative fetched log. An empty fetched log is meaningful for a
  // RUNNING story — SSE carries the live output, and the polled log_tail (a 4KB
  // suffix) would duplicate what's already in liveLog — so we keep the empty
  // baseLog there. But a non-running row whose durable-log fetch came back empty
  // (a legacy row predating the durable log, or a deleted log file) should fall
  // back to its log_tail rather than render an empty panel.
  const logBase =
    baseLog === null || (baseLog === '' && data.status !== 'running')
      ? (data.log_tail ?? '')
      : baseLog;
  const combinedLog = logBase + liveLog;

  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold">{data.story_id}</h2>
        <Badge variant={statusVariant(data.status)}>{data.status}</Badge>
      </div>

      {(isRunning || isRetryable) && (
        <div className="flex flex-wrap gap-2 mb-4">
          {isRunning && (
            <div className="flex flex-col gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={stopState.pending}
                onClick={() => { void runMutation('/api/stop', undefined, setStopState, storiesKey); }}
                data-testid="stop-btn"
              >
                {stopState.pending && (
                  <span className="mr-1 animate-spin inline-block" data-testid="stop-btn-spinner">⟳</span>
                )}
                Stop run
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
          {isRetryable && (
            <>
              <div className="flex flex-col gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={retryState.pending || cleanRetryState.pending}
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
                  disabled={cleanRetryState.pending || retryState.pending}
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
