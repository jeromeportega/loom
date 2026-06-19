#!/usr/bin/env node
/**
 * build-intake-fixture.mjs
 *
 * Validates that every epic-sourced case in the checked-in fixture
 * (packages/loom-core/eval-cases/intake-classification.yaml) has
 * recoverable brief text via recoverBriefText, logging any that cannot
 * be recovered.  Exits non-zero if the fixture fails schema validation
 * or if any epic case lacks provenance.
 *
 * This script is the "fixture-build confirmation" step (ADR-003).
 * Run after modifying the fixture or the epics/ directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'packages', 'loom-core', 'eval-cases', 'intake-classification.yaml');

// ---------------------------------------------------------------------------
// recoverBriefText inline (avoids a TS→JS compilation dependency at build time)
// ---------------------------------------------------------------------------
function recoverBriefText(epicId, root) {
  const briefPath = path.join(root, '.loom', 'planning', epicId, 'project-brief.md');
  if (fs.existsSync(briefPath)) {
    const text = fs.readFileSync(briefPath, 'utf8').trim();
    if (text.length > 0) {
      return { ok: true, text, source: path.relative(root, briefPath).split(path.sep).join('/') };
    }
  }

  const yamlPath = path.join(root, 'epics', `${epicId}.yaml`);
  if (fs.existsSync(yamlPath)) {
    const content = fs.readFileSync(yamlPath, 'utf8');
    let title;
    let description;
    try {
      const raw = yaml.load(content);
      if (raw && typeof raw === 'object') {
        title = typeof raw.title === 'string' ? raw.title : undefined;
        description = typeof raw.description === 'string' ? raw.description : undefined;
      }
    } catch { /* fall through to regex */ }

    if (!title) {
      const m = content.match(/^title:\s+"?(.+?)"?\s*$/m);
      if (m) title = m[1].trim();
    }

    if (title) {
      const text = description ? `${title}\n\n${description}` : title;
      return {
        ok: true,
        text: text.trim(),
        source: path.relative(root, yamlPath).split(path.sep).join('/'),
      };
    }
  }

  return {
    ok: false,
    reason: `No brief found for ${epicId}: checked .loom/planning/${epicId}/project-brief.md and epics/${epicId}.yaml`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log('build-intake-fixture: validating ' + FIXTURE_PATH);

const raw = yaml.load(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const cases = raw?.cases ?? [];
if (!Array.isArray(cases) || cases.length === 0) {
  console.error('FAIL: fixture has no cases');
  process.exit(1);
}

let ok = true;
let recovered = 0;
let excluded = 0;

for (const c of cases) {
  if (c.source === 'anchor') {
    if (!c.brief || c.brief.trim().length === 0) {
      console.error(`FAIL: anchor case ${c.id} has empty brief`);
      ok = false;
    } else {
      console.log(`  anchor ${c.id}: OK`);
    }
    continue;
  }

  // epic-sourced case: confirm brief is recoverable
  const result = recoverBriefText(c.id, REPO_ROOT);
  if (!result.ok) {
    console.warn(`  EXCLUDED (unrecoverable): ${c.id} — ${result.reason}`);
    excluded++;
    // An existing fixture case that is now unrecoverable is an error
    ok = false;
  } else {
    console.log(`  ${c.id}: OK (source: ${result.source})`);
    recovered++;

    // Cross-check: fixture brief_source should match resolved source
    if (c.brief_source && c.brief_source !== result.source) {
      console.warn(`  WARN: ${c.id} brief_source mismatch — fixture="${c.brief_source}" resolved="${result.source}"`);
    }
  }
}

console.log(`\n${cases.length} cases checked — ${recovered} epic briefs recovered, ${excluded} unrecoverable`);

if (!ok) {
  console.error('build-intake-fixture: FAILED');
  process.exit(1);
}
console.log('build-intake-fixture: OK');
