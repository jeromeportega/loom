import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { LessonExtractorCaseSetSchema, type LessonExtractorCase } from './caseSchema.js';

// CJS package: __dirname is available at runtime. Paths are computed lazily
// inside defaultFixturePath() so process.cwd() is read at call time, not
// at import time — tests that change cwd before calling load() get fresh values.
function defaultFixturePath(): string {
  // Compiled output at dist/eval/lesson-extractor/ — three levels up to package root
  const distPath = path.resolve(__dirname, '../../../eval-cases/lesson-extractor.yaml');
  if (fs.existsSync(distPath)) return distPath;
  // Monorepo root (e.g. `npm test` from repo root)
  const monorepoPath = path.resolve(process.cwd(), 'packages/loom-core/eval-cases/lesson-extractor.yaml');
  if (fs.existsSync(monorepoPath)) return monorepoPath;
  // Package root (e.g. `npm test` from packages/loom-core/)
  const pkgPath = path.resolve(process.cwd(), 'eval-cases/lesson-extractor.yaml');
  if (fs.existsSync(pkgPath)) return pkgPath;
  throw new Error(
    `lesson-extractor.yaml not found. Looked in:\n  ${distPath}\n  ${monorepoPath}\n  ${pkgPath}`,
  );
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Lesson-extractor eval fixture not found: ${file}`);
    }
    throw err;
  }
}

/**
 * Loads the lesson-extractor eval fixture. With no argument, loads the default
 * `eval-cases/lesson-extractor.yaml` from the package root.
 * Zod-validates every case before returning — malformed cases throw loudly.
 */
export function loadLessonExtractorCases(fixturePath?: string): LessonExtractorCase[] {
  const file = fixturePath ?? defaultFixturePath();
  const parsed = LessonExtractorCaseSetSchema.parse(
    yaml.load(readFile(file), { schema: yaml.JSON_SCHEMA }),
  );
  return parsed.cases;
}
