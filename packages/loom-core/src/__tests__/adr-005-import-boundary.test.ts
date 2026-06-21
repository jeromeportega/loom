import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// From dist/__tests__/, the workspace root is four levels up:
//   packages/loom-core/dist/__tests__  →  packages/loom-core/dist  →
//   packages/loom-core  →  packages  →  <workspace-root>
const WORKSPACE_ROOT = path.resolve(__dirname, '../../../..');
const LOOM_CORE_SRC = path.join(WORKSPACE_ROOT, 'packages', 'loom-core', 'src');

// ADR-005: the eval/ subtree is a one-way boundary — production modules must
// never import from it. Only the eval/ subtree itself may reference eval/.
const PRODUCTION_DIRS = [
  'planner',
  'orchestrator',
  'brief',
  'intake',
  'signals',
  'guardrails',
];

// Pattern that matches any import/require from the eval/ directory.
// Catches: '../eval/...', '../../eval/...', './eval/...' etc.
const EVAL_IMPORT_RE = /(?:import|require)\s*(?:type\s+)?(?:\{[^}]*\}|\*[^'"]*|[a-zA-Z_$][^\s'"]*)\s*from\s*['"][^'"]*\/eval[/'"]/;
const EVAL_IMPORT_SIMPLE_RE = /from\s*['"][^'"]*\/eval(?:\/|['"])/;

function findTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('ADR-005 import boundary — production modules must not import from eval/', () => {
  for (const dir of PRODUCTION_DIRS) {
    const absDir = path.join(LOOM_CORE_SRC, dir);

    it(`${dir}/ contains no imports from eval/`, () => {
      const files = findTsFiles(absDir);

      // If the directory doesn't exist yet, the boundary is trivially held.
      if (files.length === 0) return;

      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (EVAL_IMPORT_SIMPLE_RE.test(line)) {
            const rel = path.relative(LOOM_CORE_SRC, file);
            violations.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `ADR-005 violation — production module(s) under ${dir}/ import from eval/:\n` +
          violations.map(v => `  ${v}`).join('\n')
      );
    });
  }
});
