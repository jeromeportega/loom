import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedDecision } from './types.js';

/**
 * Persists the grilling assumption ledger as a GFM table under
 * `<loomDir>/grilling/<runId>/ledger.md`. Written for BOTH completed and
 * cancelled sessions (a cancelled run still records whatever was resolved),
 * created even when `decisions` is empty, and overwritten if the path already
 * exists (idempotent for retry safety). `runId` is always a system-generated
 * value — never operator-supplied — so it is safe as a path segment.
 */
export async function persistLedger(
  runId: string,
  decisions: ResolvedDecision[],
  loomDir: string,
): Promise<void> {
  const dir = path.join(loomDir, 'grilling', runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'ledger.md'), renderLedger(decisions), 'utf8');
}

/** GFM table with columns Decision | Blast | Answer | Tag | Citation. */
function renderLedger(decisions: ResolvedDecision[]): string {
  const header =
    '| Decision | Blast | Answer | Tag | Citation |\n' +
    '| --- | --- | --- | --- | --- |\n';
  const rows = decisions
    .map((d) =>
      `| ${cell(d.text)} | ${cell(d.blast_radius)} | ${cell(d.answer)} | ${cell(d.tag)} | ${cell(d.citation ?? '')} |`,
    )
    .join('\n');
  return rows ? header + rows + '\n' : header;
}

/** Escape a value for a GFM table cell: pipes break columns, newlines break rows. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}
