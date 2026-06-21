import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SkillJudgeEvalSetSchema, type SkillJudgeEvalCase } from './caseSchema.js';

// CJS package: __dirname is available. The compiled output lives at
// dist/eval/skill-judge/, so ../../../ resolves to the package root.
const DEFAULT_FIXTURE = path.resolve(
  __dirname,
  '../../../eval-cases/skill-judge.yaml',
);
const CWD_FIXTURE = path.resolve(
  process.cwd(),
  'packages/loom-core/eval-cases/skill-judge.yaml',
);

function defaultFixturePath(): string {
  if (fs.existsSync(DEFAULT_FIXTURE)) return DEFAULT_FIXTURE;
  if (fs.existsSync(CWD_FIXTURE)) return CWD_FIXTURE;
  throw new Error(
    `skill-judge.yaml not found. Looked in:\n  ${DEFAULT_FIXTURE}\n  ${CWD_FIXTURE}`,
  );
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Skill-judge eval fixture not found: ${file}`);
    }
    throw err;
  }
}

/**
 * Loads the skill-judge eval fixture. With no argument, loads the default
 * `eval-cases/skill-judge.yaml` from the package root.
 * Zod-validates every case before returning — malformed cases throw loudly.
 */
export function loadSkillJudgeCases(fixturePath?: string): SkillJudgeEvalCase[] {
  const file = fixturePath ?? defaultFixturePath();
  const parsed = SkillJudgeEvalSetSchema.parse(
    yaml.load(readFile(file), { schema: yaml.JSON_SCHEMA }),
  );
  return parsed.cases;
}
