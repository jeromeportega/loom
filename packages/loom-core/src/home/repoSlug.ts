import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultRemote, remoteUrl } from '../orchestrator/git.js';

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function computeRepoSlug(projectRoot: string): { slug: string; remoteUrl: string | null } {
  // Resolve symlinks so /var/folders/... (macOS os.tmpdir) and
  // /private/var/folders/... (process.cwd() in subprocesses) produce the same slug.
  const realRoot = (() => { try { return fs.realpathSync(projectRoot); } catch { return projectRoot; } })();
  const remote = defaultRemote(realRoot);
  const url = remote ? remoteUrl(realRoot, remote) : null;
  const hashInput = url ?? realRoot;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
  const name = sanitizeName(path.basename(realRoot)) || 'repo';
  return { slug: `${name}-${hash}`, remoteUrl: url };
}
