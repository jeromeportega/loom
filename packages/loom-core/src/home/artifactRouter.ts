import fs from 'node:fs';
import path from 'node:path';
import { gitSafe } from '../orchestrator/git.js';
import type { Provenance } from './types.js';
import { computeRepoSlug } from './repoSlug.js';

export type ArtifactSources = {
  brief?: string;
  prd?: string;
  architecture?: string;
  epicYaml?: string;
};

const ARTIFACT_MAP: Array<{ key: keyof ArtifactSources; dest: string }> = [
  { key: 'brief', dest: 'project-brief.md' },
  { key: 'prd', dest: 'prd.md' },
  { key: 'architecture', dest: 'architecture.md' },
  { key: 'epicYaml', dest: 'epic.yaml' },
];

export function routeArtifacts(input: {
  loomHomePath: string;
  projectRoot: string;
  epicId: string;
  runId: string;
  artifactSources: ArtifactSources;
  clock?: () => string;
}): { artifactDir: string; relDir: string; provenance: Provenance } {
  const { loomHomePath, projectRoot, epicId, runId, artifactSources } = input;
  const now = input.clock ? input.clock() : new Date().toISOString();

  const { slug, remoteUrl } = computeRepoSlug(projectRoot);

  // relDir uses posix separators so it is platform-consistent when stored in provenance / returned
  const relDir = path.posix.join('repos', slug, epicId);
  const artifactDir = path.resolve(loomHomePath, 'repos', slug, epicId);

  // Guard: epicId must not traverse outside loomHomePath (e.g. epicId='../../../etc')
  const resolvedHome = path.resolve(loomHomePath);
  if (!artifactDir.startsWith(resolvedHome + path.sep)) {
    throw new Error(`epicId resolves outside loomHomePath — possible path traversal: ${epicId}`);
  }

  // Guard: refuse to silently overwrite an existing run's artifacts
  const provenancePath = path.join(artifactDir, 'provenance.json');
  if (fs.existsSync(provenancePath)) {
    throw new Error(
      `Artifact directory already contains provenance.json — will not overwrite: ${artifactDir}`,
    );
  }

  fs.mkdirSync(artifactDir, { recursive: true });

  for (const { key, dest } of ARTIFACT_MAP) {
    const src = artifactSources[key];
    if (src !== undefined && fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(artifactDir, dest));
    }
  }

  const headRes = gitSafe(projectRoot, ['rev-parse', 'HEAD']);
  const rawSha = headRes.output.trim();
  const target_head_sha = headRes.ok && rawSha.length > 0 ? rawSha : null;

  const provenance: Provenance = {
    loom_home_schema: 1,
    target_repo: {
      name: path.basename(projectRoot),
      path: projectRoot,
      remote_url: remoteUrl,
      slug,
    },
    epic_id: epicId,
    run_id: runId,
    target_head_sha,
    created_at: now,
  };

  fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2), 'utf8');

  return { artifactDir, relDir, provenance };
}
