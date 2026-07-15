import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuditVerify } from '@/hooks/useAuditVerify';

export function AuditIntegrityBadge(): JSX.Element {
  const { data, isPending, isError } = useAuditVerify();

  if (isPending) {
    return <Skeleton className="h-5 w-20" />;
  }

  if (isError || data == null) {
    return <Badge variant="secondary">Unknown</Badge>;
  }

  if (data.ok) {
    return <Badge variant="default">Chain intact</Badge>;
  }

  return (
    <Badge variant="destructive">
      {data.brokenAtId != null ? `Broken at #${data.brokenAtId}` : 'Chain broken'}
    </Badge>
  );
}
