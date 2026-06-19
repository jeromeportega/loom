import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { IntakeEvalSetSchema, type IntakeEvalCase } from './intakeEvalTypes.js';

function defaultFixturePath(): string {
  const candidates = [
    path.resolve(__dirname, '../../eval-cases/intake-classification.yaml'),
    path.resolve(__dirname, '../eval-cases/intake-classification.yaml'),
    path.resolve(process.cwd(), 'packages/loom-core/eval-cases/intake-classification.yaml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `intake-classification.yaml not found. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Loads the intake eval fixture. With no argument, loads the default
 * `eval-cases/intake-classification.yaml` from the package root.
 * Validates the result against IntakeEvalSetSchema before returning.
 */
export function loadIntakeEvalSet(fixturePath?: string): IntakeEvalCase[] {
  const file = fixturePath ?? defaultFixturePath();
  if (!fs.existsSync(file)) {
    throw new Error(`Intake eval fixture not found: ${file}`);
  }
  const parsed = IntakeEvalSetSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
  return parsed.cases;
}
