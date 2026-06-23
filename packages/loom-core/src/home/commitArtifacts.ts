import { gitSafe } from '../orchestrator/git.js';
import type { Provenance } from './types.js';
import type { EpicStore } from '../state/EpicStore.js';

export type CommitArtifactsResult =
  | { status: 'committed'; sha: string }
  | { status: 'pending'; reason: string };

function buildCommitMessage(provenance: Provenance): string {
  const { target_repo, epic_id, run_id, target_head_sha } = provenance;
  return [
    `loom: artifacts for ${target_repo.slug}/${epic_id}`,
    '',
    `Target-Repo: ${target_repo.name}`,
    `Target-Path: ${target_repo.path}`,
    `Target-Head: ${target_head_sha ?? 'none'}`,
    `Epic: ${epic_id}`,
    `Run-Id: ${run_id}`,
  ].join('\n');
}

/**
 * Stages and commits `relDir` in loom-home, then records the outcome via
 * EpicStore. Never throws into the finalize critical path — returns a
 * discriminated result instead. On failure, sets loom_home_status='pending'
 * so a reconciler can retry; on success, sets 'committed' and records the sha.
 *
 * Idempotent: if the files are already committed (nothing to stage), reads
 * HEAD sha and marks committed. This covers the case where a prior attempt
 * committed but failed before writing to the DB.
 */
export function commitArtifacts(input: {
  loomHomePath: string;
  relDir: string;
  epicId: string;
  provenance: Provenance;
  store: EpicStore;
}): CommitArtifactsResult {
  const { loomHomePath, relDir, epicId, provenance, store } = input;

  try {
    // Ensure a git user identity is set for this repo so commits don't fail
    // in a bare environment that has no global user config.
    gitSafe(loomHomePath, ['config', 'user.email', 'loom@loom.local']);
    gitSafe(loomHomePath, ['config', 'user.name', 'loom']);

    const addResult = gitSafe(loomHomePath, ['add', relDir]);
    if (!addResult.ok) {
      store.setLoomHomeStatus(epicId, 'pending');
      return { status: 'pending', reason: `git add failed: ${addResult.output}` };
    }

    const message = buildCommitMessage(provenance);
    const commitResult = gitSafe(loomHomePath, ['commit', '-m', message]);

    if (!commitResult.ok) {
      // Idempotency: if nothing is staged (e.g., the artifacts were already
      // committed in a previous partially-successful attempt), treat the
      // existing HEAD commit as the success sha.
      if (
        commitResult.output.includes('nothing to commit') ||
        commitResult.output.includes('nothing added to commit')
      ) {
        const shaResult = gitSafe(loomHomePath, ['rev-parse', 'HEAD']);
        if (shaResult.ok) {
          const sha = shaResult.output.trim();
          store.setLoomHomeStatus(epicId, 'committed', sha);
          return { status: 'committed', sha };
        }
      }
      store.setLoomHomeStatus(epicId, 'pending');
      return { status: 'pending', reason: `git commit failed: ${commitResult.output}` };
    }

    const shaResult = gitSafe(loomHomePath, ['rev-parse', 'HEAD']);
    if (!shaResult.ok) {
      store.setLoomHomeStatus(epicId, 'pending');
      return { status: 'pending', reason: `rev-parse HEAD failed after commit: ${shaResult.output}` };
    }
    const sha = shaResult.output.trim();
    store.setLoomHomeStatus(epicId, 'committed', sha);
    return { status: 'committed', sha };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      store.setLoomHomeStatus(epicId, 'pending');
    } catch {
      // DB write failed too — return pending with the original reason.
    }
    return { status: 'pending', reason };
  }
}
