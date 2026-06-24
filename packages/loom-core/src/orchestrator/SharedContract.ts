import fs from 'node:fs';
import path from 'node:path';

/**
 * The epic-wide shared implementation contract: the architect's answer to the
 * "workers in a vacuum" problem. Parallel story workers each branch from their
 * own base and never see each other's code, so they invent conflicting
 * interfaces and edit the same files. The contract — shared interfaces/types
 * plus a per-story file-ownership map — is produced once at plan time (Winston,
 * Headless task C) and injected into EVERY worker prompt for the epic so the
 * parallel agents agree on the seams and stay in their lane.
 *
 * Persisted as a sibling of the guidance/ and handoff/ side-channels so the
 * worker-prompt builder can read it by `epicId` at dispatch with no extra
 * threading. Gated end-to-end (policy.agents.shared_contract) so the worker
 * prompt is byte-identical to the bench baseline when off.
 *
 * File-ownership table format (cross-repo epics): the architect emits a `| Repo |`
 * column between the Story and Owns columns to identify which registered manifest
 * slug each story targets. Single-repo epics omit the column — the parser in
 * ContractOwnership.ts handles both layouts. The content is injected verbatim
 * into every parallel worker prompt so producer and consumer stories receive
 * identical repo-identity context.
 */
export class SharedContract {
  /** Path where an epic's shared contract is materialized. */
  static pathFor(projectRoot: string, epicId: string): string {
    return path.join(projectRoot, '.loom', 'contract', `${epicId}.md`);
  }

  /** Reads the materialized contract, or null when none exists / is empty. */
  static read(projectRoot: string, epicId: string): string | null {
    try {
      const body = fs.readFileSync(SharedContract.pathFor(projectRoot, epicId), 'utf8');
      return body.trim().length > 0 ? body : null;
    } catch {
      return null;
    }
  }

  /** Writes the contract to disk, creating `.loom/contract/` as needed. */
  static write(projectRoot: string, epicId: string, content: string): string {
    const file = SharedContract.pathFor(projectRoot, epicId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return file;
  }
}
