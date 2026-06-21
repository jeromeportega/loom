import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { SkillJudgeEvalSetSchema, type SkillJudgeEvalCase } from './caseSchema.js';

function defaultFixturePath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../eval-cases/skill-judge.yaml'),
    path.resolve(__dirname, '../../eval-cases/skill-judge.yaml'),
    path.resolve(process.cwd(), 'packages/loom-core/eval-cases/skill-judge.yaml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `skill-judge.yaml not found. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Loads the skill-judge eval fixture. With no argument, loads the default
 * `eval-cases/skill-judge.yaml` from the package root.
 * Zod-validates every case before returning — malformed cases throw loudly.
 */
export function loadSkillJudgeCases(fixturePath?: string): SkillJudgeEvalCase[] {
  const file = fixturePath ?? defaultFixturePath();
  if (fixturePath && !fs.existsSync(file)) {
    throw new Error(`Skill-judge eval fixture not found: ${file}`);
  }
  const parsed = SkillJudgeEvalSetSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
  return parsed.cases;
}
