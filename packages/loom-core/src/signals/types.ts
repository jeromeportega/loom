export type SignalSource = 'audit-introspection' | 'code-debt' | 'github-issues';

export interface Signal {
  key: string;                  // stable dedup identity, scanner-deterministic
  source: SignalSource;
  kind: string;                 // 'work_failure_cluster' | 'todo' | 'github_issue' | ...
  title: string;
  detail?: string;              // longer text fed to the clustering LLM
  evidenceUrl?: string;         // 'file:line', gh issue URL, or audit reference
  weight?: number;              // default 1
  metadata?: Record<string, unknown>;
}

export interface SignalRecord extends Signal {
  id: number;                   // batch-local id the LLM clusters on (ADR-005)
  status: 'open' | 'stale';
  first_seen: string;
  last_seen: string;
}
