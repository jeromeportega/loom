import { useNavigate } from 'react-router-dom';
import { useRepos } from '../hooks/useRepos';
import { routes } from '../lib/routes';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';

export function RepositoryList() {
  const navigate = useNavigate();
  const { data, isLoading, isError } = useRepos();
  // Normalize once so a partial/malformed response renders an empty state
  // rather than throwing mid-render and white-screening the dashboard.
  const repos = data?.repos ?? [];

  return (
    <div data-testid="repository-list">
      {isLoading && (
        <>
          <Skeleton className="h-20 w-full mb-4" />
          <Skeleton className="h-20 w-full mb-4" />
          <Skeleton className="h-20 w-full" />
        </>
      )}

      {!isLoading && isError && (
        <p className="text-muted-foreground">Failed to load repositories.</p>
      )}

      {!isLoading && !isError && repos.length === 0 && (
        <p className="text-muted-foreground">No repositories found.</p>
      )}

      {!isLoading && !isError && repos.length > 0 && (
        <div className="space-y-4">
          {repos.map((repo) => (
            <Card
              key={repo.slug}
              className="cursor-pointer hover:bg-accent transition-colors"
              onClick={() => navigate(routes.epics(repo.slug))}
            >
              <CardHeader>
                <CardTitle>{repo.slug}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{repo.root}</p>
                <p className="text-sm">{repo.epic_count} epic(s)</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
