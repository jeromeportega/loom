import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { EvalSuiteSchema, type EvalCase } from './types.js';

/** Resolves the bundled `eval-cases/` directory, shipped at the package root. */
function evalCasesDir(): string {
  const candidates = [
    path.resolve(__dirname, '../../eval-cases'),
    path.resolve(__dirname, '../eval-cases'),
    path.resolve(process.cwd(), 'packages/loom-core/eval-cases'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`loom eval-cases directory not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

/** Loads and validates an eval suite YAML file by name (default: planning). */
export function loadEvalSuite(suite = 'planning'): EvalCase[] {
  const file = path.join(evalCasesDir(), `${suite}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Eval suite not found: ${file}`);
  }
  const parsed = EvalSuiteSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
  return parsed.cases;
}
