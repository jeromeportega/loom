import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, PolicyEngine, prepareRepoState } from '@loom-ai/core';

/**
 * Resolves the canonical database for a project root via prepareRepoState
 * (idempotent resolve+migrate+lock, ADR-006 / story-053) and returns an
 * open database pointed at the loom-home namespace path.
 *
 * All CLI commands that open the state database must use this helper instead
 * of openDatabase(loomDir) to ensure every invocation triggers the one-time
 * migration before opening the database — no command sees the legacy
 * <target-repo>/.loom/loom.db path after a sibling `loom run` has migrated it.
 */
export function openProjectDatabase(projectRoot: string): ReturnType<typeof openDatabase> {
  // Resolve symlinks so callers that pass os.tmpdir()-based paths on macOS
  // (e.g. /var/folders/…) produce the same slug as subprocesses whose
  // process.cwd() returns the real path (/private/var/folders/…).
  let realRoot = projectRoot;
  try { realRoot = fs.realpathSync(projectRoot); } catch { /* fall back to raw path */ }
  const loomDir = path.join(realRoot, '.loom');
  let policy: { loom_home?: string } = {};
  try {
    policy = PolicyEngine.load(loomDir).policyData;
  } catch { /* tolerate missing/malformed policy */ }
  const { namespaceDir } = prepareRepoState(realRoot, policy);
  return openDatabase(namespaceDir);
}
