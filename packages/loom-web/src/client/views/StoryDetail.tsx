import { useParams } from 'react-router-dom';
import { useStory } from '../hooks/useStory';
import { statusVariant } from '../lib/statusVariant';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';

export function StoryDetail() {
  const { slug = '', epicId = '', storyId = '' } = useParams<{
    slug: string;
    epicId: string;
    storyId: string;
  }>();
  const { data, isLoading, isError, error } = useStory(slug, epicId, storyId);

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

  return (
    <div className="p-4">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-semibold">{data.story_id}</h2>
        <Badge variant={statusVariant(data.status)}>{data.status}</Badge>
      </div>
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
        {/* forceMount keeps content in DOM when inactive — avoids losing scroll
            position and ensures the pre element is accessible to screen readers
            even before the tab is clicked. */}
        <TabsContent value="log" forceMount>
          <pre
            className="text-xs overflow-auto bg-muted p-3 rounded font-mono mt-2"
            data-testid="log-output"
          >
            {data.log_tail ?? 'No log output yet.'}
          </pre>
        </TabsContent>
      </Tabs>
    </div>
  );
}
