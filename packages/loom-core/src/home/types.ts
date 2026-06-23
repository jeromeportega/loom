export interface Provenance {
  loom_home_schema: 1;
  target_repo: {
    name: string;
    path: string;
    remote_url: string | null;
    slug: string;
  };
  epic_id: string;
  run_id: string;
  target_head_sha: string | null;
  created_at: string;
}
