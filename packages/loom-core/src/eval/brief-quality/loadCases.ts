import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { BriefQualityCaseSetSchema, type BriefQualityCase } from './caseSchema.js';

function defaultFixturePath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../eval-cases/brief-quality.yaml'),
    path.resolve(__dirname, '../../eval-cases/brief-quality.yaml'),
    path.resolve(process.cwd(), 'packages/loom-core/eval-cases/brief-quality.yaml'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `brief-quality.yaml not found. Looked in:\n  ${candidates.join('\n  ')}`,
  );
}

/**
 * Loads the brief-quality eval fixture. With no argument, loads the default
 * `eval-cases/brief-quality.yaml` from the package root.
 * Zod-validates every case before returning — malformed cases throw loudly.
 */
export function loadBriefQualityCases(fixturePath?: string): BriefQualityCase[] {
  const file = fixturePath ?? defaultFixturePath();
  if (fixturePath && !fs.existsSync(file)) {
    throw new Error(`Brief-quality eval fixture not found: ${file}`);
  }
  const parsed = BriefQualityCaseSetSchema.parse(yaml.load(fs.readFileSync(file, 'utf8')));
  return parsed.cases;
}
