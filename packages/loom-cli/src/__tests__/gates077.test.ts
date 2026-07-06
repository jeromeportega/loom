/**
 * Static content assertions for story-077-005.
 *
 * Verifies that the three new loom finalize gates (contract-symbol drift,
 * undocumented env-var, cross-epic regression) and the tech_notes N of M
 * metric label are documented in docs/capabilities.md, README.md, and
 * docs/runbooks/finalize.md, and that the old "enriched with tech notes"
 * label has been removed from all documentation files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// __dirname = packages/loom-cli/dist/__tests__
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const CAPABILITIES = path.join(REPO_ROOT, 'docs', 'capabilities.md');
const README = path.join(REPO_ROOT, 'README.md');
const FINALIZE_RUNBOOK = path.join(REPO_ROOT, 'docs', 'runbooks', 'finalize.md');

const GATE_NAMES = [
  'contract-symbol drift',
  'undocumented env-var',
  'cross-epic regression',
];

// ── File existence ─────────────────────────────────────────────────────────

describe('gates077 — required files exist', () => {
  for (const [label, file] of [
    ['docs/capabilities.md', CAPABILITIES],
    ['README.md', README],
    ['docs/runbooks/finalize.md', FINALIZE_RUNBOOK],
  ] as [string, string][]) {
    it(`${label} exists`, () => {
      assert.ok(fs.existsSync(file), `Expected file to exist: ${file}`);
    });
  }
});

// ── docs/capabilities.md ──────────────────────────────────────────────────

describe('gates077 — docs/capabilities.md', () => {
  const doc = fs.readFileSync(CAPABILITIES, 'utf8');

  for (const gateName of GATE_NAMES) {
    it(`contains gate name "${gateName}"`, () => {
      assert.ok(
        doc.includes(gateName),
        `capabilities.md must document the "${gateName}" gate`
      );
    });
  }

  it('contains tech_notes N of M pattern', () => {
    assert.ok(
      doc.includes('tech_notes') && (doc.includes('of M') || /tech_notes \d+ of \d+|tech_notes N of M/.test(doc)),
      'capabilities.md must describe the tech_notes N of M metric pattern'
    );
  });

  it('does not contain "enriched with tech notes"', () => {
    assert.ok(
      !doc.includes('enriched with tech notes'),
      'capabilities.md must not contain the old "enriched with tech notes" label'
    );
  });

  it('references policy.agents.integration_gate for the finalize gates', () => {
    // The finalize correctness gates row should mention integration_gate
    const lines = doc.split('\n');
    const finalizeLine = lines.find(
      (l) => l.includes('Finalize correctness gates') && l.trimStart().startsWith('|')
    );
    assert.ok(finalizeLine, 'capabilities.md must have a "Finalize correctness gates" row');
    assert.ok(
      finalizeLine!.includes('integration_gate'),
      'Finalize correctness gates row must reference integration_gate policy knob'
    );
  });

  it('documents .env.example-absent skip behavior', () => {
    assert.ok(
      doc.includes('.env.example'),
      'capabilities.md must mention .env.example in the context of the undocumented env-var gate'
    );
  });

  it('documents audit row names for the three gates', () => {
    assert.ok(doc.includes('epic_finalize_symbol_drift'), 'missing audit action: epic_finalize_symbol_drift');
    assert.ok(doc.includes('epic_finalize_undoc_env_var'), 'missing audit action: epic_finalize_undoc_env_var');
    assert.ok(doc.includes('epic_finalize_regression'), 'missing audit action: epic_finalize_regression');
  });
});

// ── README.md ─────────────────────────────────────────────────────────────

describe('gates077 — README.md', () => {
  const readme = fs.readFileSync(README, 'utf8');

  for (const gateName of GATE_NAMES) {
    it(`contains gate name "${gateName}"`, () => {
      assert.ok(
        readme.includes(gateName),
        `README.md must mention the "${gateName}" gate`
      );
    });
  }

  it('contains tech_notes', () => {
    assert.ok(readme.includes('tech_notes'), 'README.md must mention tech_notes');
  });

  it('does not contain "enriched with tech notes"', () => {
    assert.ok(
      !readme.includes('enriched with tech notes'),
      'README.md must not contain the old "enriched with tech notes" label'
    );
  });
});

// ── docs/runbooks/finalize.md ─────────────────────────────────────────────

describe('gates077 — docs/runbooks/finalize.md', () => {
  const runbook = fs.readFileSync(FINALIZE_RUNBOOK, 'utf8');

  for (const gateName of GATE_NAMES) {
    it(`contains gate name "${gateName}"`, () => {
      assert.ok(
        runbook.includes(gateName),
        `finalize runbook must describe the "${gateName}" gate`
      );
    });
  }

  it('references integration_gate policy knob', () => {
    assert.ok(
      runbook.includes('integration_gate'),
      'finalize runbook must mention the integration_gate policy knob'
    );
  });

  it('describes .env.example-absent skip behavior', () => {
    assert.ok(
      runbook.includes('.env.example'),
      'finalize runbook must describe the .env.example-absent skip behavior'
    );
    assert.ok(
      runbook.toLowerCase().includes('absent') || runbook.toLowerCase().includes('skip'),
      'finalize runbook must mention the skip behavior when .env.example is absent'
    );
  });

  it('does not contain "enriched with tech notes"', () => {
    assert.ok(
      !runbook.includes('enriched with tech notes'),
      'finalize runbook must not contain the old "enriched with tech notes" label'
    );
  });
});

// ── No "enriched with tech notes" in any docs file ────────────────────────

describe('gates077 — no "enriched with tech notes" in any docs file', () => {
  const docsRoot = path.join(REPO_ROOT, 'docs');

  function findMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const mdFiles = [README, ...findMarkdownFiles(docsRoot)];

  it('no documentation file contains "enriched with tech notes"', () => {
    const hits: string[] = [];
    for (const f of mdFiles) {
      if (!fs.existsSync(f)) continue;
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('enriched with tech notes')) {
        hits.push(path.relative(REPO_ROOT, f));
      }
    }
    assert.deepEqual(
      hits,
      [],
      `"enriched with tech notes" found in: ${hits.join(', ')}`
    );
  });
});
