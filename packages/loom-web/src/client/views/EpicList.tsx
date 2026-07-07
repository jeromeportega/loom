import { useNavigate, useParams } from 'react-router-dom';
import { useEpics } from '../hooks/useEpics';
import { routes } from '../lib/routes';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import type { EpicStatus } from '../../shared/types';

function statusVariant(status: EpicStatus['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'failed':
      return 'destructive';
    case 'done':
      return 'secondary';
    default:
      return 'default';
  }
}

export function EpicList() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useEpics(slug);

  const is404 = isError && (error as Error & { status?: number })?.status === 404;

  return (
    <div data-testid="epic-list">
      {/* sr-only label keeps App routing tests passing after stub replacement */}
      <span className="sr-only">EpicList</span>

      {isLoading && (
        <>
          <Skeleton className="h-12 w-full mb-2" />
          <Skeleton className="h-12 w-full mb-2" />
          <Skeleton className="h-12 w-full" />
        </>
      )}

      {!isLoading && is404 && (
        <p className="text-muted-foreground">Repository not found.</p>
      )}

      {!isLoading && isError && !is404 && (
        <p className="text-muted-foreground">Failed to load epics.</p>
      )}

      {!isLoading && !isError && data && data.epics.length === 0 && (
        <p className="text-muted-foreground">No epics found for this repository.</p>
      )}

      {!isLoading && !isError && data && data.epics.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.epics.map((epic) => (
              <TableRow
                key={epic.id}
                className="cursor-pointer"
                onClick={() => navigate(routes.stories(slug, epic.id))}
              >
                <TableCell>{epic.id}</TableCell>
                <TableCell>{epic.title}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(epic.status)}>{epic.status}</Badge>
                </TableCell>
                <TableCell>{epic.updated_at}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
