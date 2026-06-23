import crypto from 'node:crypto';
import path from 'node:path';
import { defaultRemote, remoteUrl } from '../orchestrator/git.js';

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function computeRepoSlug(projectRoot: string): { slug: string; remoteUrl: string | null } {
  const remote = defaultRemote(projectRoot);
  const url = remote ? remoteUrl(projectRoot, remote) : null;
  const hashInput = url ?? projectRoot;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  const name = sanitizeName(path.basename(projectRoot)) || 'repo';
  return { slug: `${name}-${hash}`, remoteUrl: url };
}
