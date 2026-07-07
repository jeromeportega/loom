import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

export interface DeadFieldFinding {
  field: string;
  reason: string;
}

export interface DeadFieldResult {
  findings: DeadFieldFinding[];
  scannedFields: string[];
  durationMs: number;
}

/**
 * Parses the `agents` section of a `policy.schema.yaml` file and greps
 * production TypeScript source (excluding `__tests__/`, `*.test.ts`,
 * `*.spec.ts`, and `fixtures/` directories) for property reads of each field.
 *
 * A field is "dead" when no production source file contains `.fieldName` or
 * `["fieldName"]` or `['fieldName']`. No LLM calls, no network I/O.
 */
export function checkDeadPolicyFields(opts: {
  schemaPath: string;
  projectRoot: string;
}): DeadFieldResult {
  const startNs = process.hrtime.bigint();

  let schema: unknown;
  try {
    const content = fs.readFileSync(opts.schemaPath, 'utf8');
    schema = yaml.load(content);
  } catch {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    return { findings: [], scannedFields: [], durationMs };
  }

  const agentsProps = (schema as any)?.properties?.agents?.properties;
  if (!agentsProps || typeof agentsProps !== 'object') {
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    return { findings: [], scannedFields: [], durationMs };
  }

  const scannedFields = Object.keys(agentsProps);
  const findings: DeadFieldFinding[] = [];

  for (const field of scannedFields) {
    if (!hasProductionRead(field, opts.projectRoot)) {
      findings.push({
        field,
        reason: 'defined in agents schema; zero production reads found',
      });
    }
  }

  const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
  return { findings, scannedFields, durationMs };
}

// Checks whether any production TypeScript source file contains a property
// read of the given field. Bare word occurrences (comments, prose) do NOT count.
function hasProductionRead(field: string, projectRoot: string): boolean {
  // Matches .fieldName (dot access) or ["fieldName"] or ['fieldName'] (bracket access).
  const pattern = `\\.${field}\\b|\\["${field}"\\]|\\['${field}'\\]`;

  try {
    execFileSync('grep', [
      '-r',                      // recursive
      '-q',                      // quiet: exit 0 on first match, no output
      '-E',                      // extended regex
      '--include=*.ts',          // TypeScript source files only
      '--exclude-dir=__tests__', // skip test directories
      '--exclude-dir=fixtures',  // skip fixture directories
      '--exclude=*.test.ts',     // skip test files
      '--exclude=*.spec.ts',     // skip spec files
      pattern,
      projectRoot,
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return false;
    return false;
  }
}
