import { useNavigate, useParams } from 'react-router-dom';
import { useStories } from '../hooks/useStories';
import { routes } from '../lib/routes';
import { statusVariant } from '../lib/statusVariant';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

export function StoryList() {
  const { slug = '', epicId = '' } = useParams<{ slug: string; epicId: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useStories(slug, epicId);

  if (isLoading) {
    return (
      <div className="p-4 space-y-2" aria-busy="true" data-testid="story-list-loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  if (isError) {
    return <p className="p-4 text-destructive">Failed to load stories.</p>;
  }

  if (!data) return null;

  return (
    <div className="p-4">
      <h2 className="text-lg font-semibold mb-4">Stories — {epicId}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Story</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.stories.map((story) => (
            <TableRow
              key={story.id}
              className="cursor-pointer"
              onClick={() => navigate(routes.story(slug, epicId, story.story_id))}
            >
              <TableCell>{story.story_id}</TableCell>
              <TableCell>{story.story_title ?? '—'}</TableCell>
              <TableCell>
                <Badge variant={statusVariant(story.status)}>{story.status}</Badge>
              </TableCell>
              <TableCell>{story.updated_at}</TableCell>
            </TableRow>
          ))}
          {data.stories.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-center text-muted-foreground">
                No stories found.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
