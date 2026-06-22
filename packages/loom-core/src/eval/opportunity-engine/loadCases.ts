import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { OpportunityEngineCaseSetSchema, type OpportunityEngineCase } from './caseSchema.js';

// CJS module: packages/loom-core has "type":"commonjs" in its package.json and
// emits CommonJS via tsconfig module:Node16 — __dirname is a module-load-time
// constant (not call-time).  process.cwd() inside defaultFixturePath() IS read
// at call time, so tests that change cwd before calling load() get fresh values.
// If this package is ever migrated to ESM, replace __dirname with
//   path.dirname(fileURLToPath(import.meta.url))
// and add `import { fileURLToPath } from 'node:url';`.
export function defaultFixturePath(): string {
  // Compiled output at dist/eval/opportunity-engine/ — three levels up to package root
  const distPath = path.resolve(__dirname, '../../../eval-cases/opportunity-engine.yaml');
  if (fs.existsSync(distPath)) return distPath;
  // Monorepo root (e.g. `npm test` from repo root)
  const monorepoPath = path.resolve(process.cwd(), 'packages/loom-core/eval-cases/opportunity-engine.yaml');
  if (fs.existsSync(monorepoPath)) return monorepoPath;
  // Package root (e.g. `npm test` from packages/loom-core/)
  const pkgPath = path.resolve(process.cwd(), 'eval-cases/opportunity-engine.yaml');
  if (fs.existsSync(pkgPath)) return pkgPath;
  throw new Error(
    `opportunity-engine.yaml not found. Looked in:\n  ${distPath}\n  ${monorepoPath}\n  ${pkgPath}`,
  );
}

function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Opportunity-engine eval fixture not found: ${file}`);
    }
    throw err;
  }
}

/**
 * Loads the opportunity-engine eval fixture. With no argument, loads the default
 * `eval-cases/opportunity-engine.yaml` from the package root.
 * Zod-validates every case before returning — malformed cases throw loudly.
 */
export function loadOpportunityEngineCases(fixturePath?: string): OpportunityEngineCase[] {
  const file = fixturePath ?? defaultFixturePath();
  // JSON_SCHEMA disallows YAML anchors/aliases — fixture authors must not use them.
  const parsed = OpportunityEngineCaseSetSchema.parse(
    yaml.load(readFile(file), { schema: yaml.JSON_SCHEMA }),
  );
  return parsed.cases;
}
