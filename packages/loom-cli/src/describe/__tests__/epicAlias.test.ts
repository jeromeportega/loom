import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { CommandDescriptionSchema } from '../schema.js';
import { collectSpecs } from '../registry.js';
import { spec as epicSpec } from '../../commands/epic.js';
import { applySpec } from '../applySpec.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// __dirname at runtime: dist/describe/__tests__
// 5 levels up: dist/describe/__tests__ → dist/describe → dist → loom-cli → packages → repo root
const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

function captureHelp(cmd: Command): string {
  let output = '';
  cmd.configureOutput({ writeOut: (str) => { output += str; } });
  cmd.outputHelp();
  return output;
}

// ---------------------------------------------------------------------------
// epic spec — alias label assertions
// ---------------------------------------------------------------------------

describe('epic spec — alias of weave', () => {
  it('spec passes CommandDescriptionSchema validation', () => {
    const result = CommandDescriptionSchema.safeParse(epicSpec);
    if (!result.success) {
      const msgs = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
      assert.fail(`epic spec failed CommandDescriptionSchema:\n${msgs}`);
    }
  });

  it('spec.whenToUse marks epic as an alias of weave', () => {
    const { whenToUse } = epicSpec;
    assert.ok(
      whenToUse.toLowerCase().includes('alias'),
      `spec.whenToUse must mention "alias", got: ${whenToUse}`
    );
    assert.ok(
      whenToUse.toLowerCase().includes('weave'),
      `spec.whenToUse must reference "weave", got: ${whenToUse}`
    );
  });

  it('spec.summary surfaces the alias label (flows to --help)', () => {
    const { summary } = epicSpec;
    assert.ok(
      summary.toLowerCase().includes('alias'),
      `spec.summary must mention "alias", got: ${summary}`
    );
    assert.ok(
      summary.toLowerCase().includes('weave'),
      `spec.summary must reference "weave", got: ${summary}`
    );
  });

  it('loom describe JSON for epic surfaces the alias label (whenToUse)', () => {
    const found = collectSpecs().find((s) => s.name === 'epic');
    assert.ok(found, 'epic spec must appear in collectSpecs()');
    assert.ok(
      found.whenToUse.toLowerCase().includes('alias'),
      `loom describe epic JSON (whenToUse) must mention "alias"`
    );
    assert.ok(
      found.whenToUse.toLowerCase().includes('weave'),
      `loom describe epic JSON (whenToUse) must reference "weave"`
    );
  });

  it('loom epic --help surfaces the alias label (via spec.summary)', () => {
    const cmd = new Command('epic');
    cmd.exitOverride();
    applySpec(cmd, epicSpec);
    const helpText = captureHelp(cmd);
    assert.ok(
      helpText.toLowerCase().includes('alias'),
      `loom epic --help must mention "alias"; got:\n${helpText}`
    );
    assert.ok(
      helpText.toLowerCase().includes('weave'),
      `loom epic --help must reference "weave"; got:\n${helpText}`
    );
  });

  it('epic spec is still present in collectSpecs() (no behavior removal)', () => {
    const found = collectSpecs().find((s) => s.name === 'epic');
    assert.ok(found, 'epic must still be present in collectSpecs() — it must remain a working alias');
  });
});

// ---------------------------------------------------------------------------
// README — first-run and command-reference sections lead with loom weave
// ---------------------------------------------------------------------------

describe('README — loom weave precedes loom epic', () => {
  const readmePath = resolve(repoRoot, 'README.md');

  function readReadme(): string {
    return readFileSync(readmePath, 'utf8');
  }

  it('first-run section (## First 10 minutes) leads with loom weave before loom epic', () => {
    const readme = readReadme();
    const sectionStart = readme.indexOf('## First 10 minutes');
    assert.ok(sectionStart !== -1, '"## First 10 minutes" section must exist in README');
    // Find the next ## heading after this section
    const nextSection = readme.indexOf('\n## ', sectionStart + 1);
    const section = nextSection !== -1
      ? readme.slice(sectionStart, nextSection)
      : readme.slice(sectionStart);

    const weavePos = section.indexOf('loom weave');
    const epicPos = section.indexOf('loom epic');
    assert.ok(weavePos !== -1, '"loom weave" must appear in the first-run section');
    assert.ok(
      epicPos === -1 || weavePos < epicPos,
      `"loom weave" must precede "loom epic" in the first-run section (weavePos=${weavePos}, epicPos=${epicPos})`
    );
  });

  it('command-reference section (## Command reference) leads with loom weave before loom epic', () => {
    const readme = readReadme();
    const sectionStart = readme.indexOf('## Command reference');
    assert.ok(sectionStart !== -1, '"## Command reference" section must exist in README');
    const nextSection = readme.indexOf('\n## ', sectionStart + 1);
    const section = nextSection !== -1
      ? readme.slice(sectionStart, nextSection)
      : readme.slice(sectionStart);

    const weavePos = section.indexOf('loom weave');
    const epicPos = section.indexOf('loom epic');
    assert.ok(weavePos !== -1, '"loom weave" must appear in the command-reference section');
    assert.ok(
      epicPos === -1 || weavePos < epicPos,
      `"loom weave" must precede "loom epic" in the command-reference section (weavePos=${weavePos}, epicPos=${epicPos})`
    );
  });
});

// ---------------------------------------------------------------------------
// Vendored loom-epic skill — notes weave is canonical
// ---------------------------------------------------------------------------

describe('vendored loom-epic skill — weave is canonical', () => {
  it('.claude/skills/loom-epic/SKILL.md exists and notes weave is canonical', () => {
    const skillPath = resolve(repoRoot, '.claude', 'skills', 'loom-epic', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    assert.ok(
      content.toLowerCase().includes('canonical'),
      '.claude/skills/loom-epic/SKILL.md must note that loom weave is canonical'
    );
    assert.ok(
      content.includes('loom weave'),
      '.claude/skills/loom-epic/SKILL.md must reference `loom weave`'
    );
  });

  it('.agents/skills/loom-epic/SKILL.md exists and notes weave is canonical', () => {
    const skillPath = resolve(repoRoot, '.agents', 'skills', 'loom-epic', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    assert.ok(
      content.toLowerCase().includes('canonical'),
      '.agents/skills/loom-epic/SKILL.md must note that loom weave is canonical'
    );
    assert.ok(
      content.includes('loom weave'),
      '.agents/skills/loom-epic/SKILL.md must reference `loom weave`'
    );
  });
});
