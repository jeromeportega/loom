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
import { StatusChip } from '../components';
import { Skeleton } from '../components/ui/skeleton';
import type { EpicStatus } from '../../shared/types';

export function EpicList() {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useEpics(slug);

  const is404 = isError && (error as Error & { status?: number })?.status === 404;
  // Normalize once so a partial/malformed response renders an empty state
  // rather than throwing mid-render.
  const epics = data?.epics ?? [];

  return (
    <div data-testid="epic-list">
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

      {!isLoading && !isError && epics.length === 0 && (
        <p className="text-muted-foreground">No epics found for this repository.</p>
      )}

      {!isLoading && !isError && epics.length > 0 && (
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
            {epics.map((epic) => (
              <TableRow
                key={epic.id}
                className="cursor-pointer"
                onClick={() => navigate(routes.stories(slug, epic.id))}
              >
                <TableCell>{epic.id}</TableCell>
                <TableCell>{epic.title}</TableCell>
                <TableCell>
                  <StatusChip status={epic.status} />
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
