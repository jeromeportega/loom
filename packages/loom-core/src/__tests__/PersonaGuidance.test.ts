import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// At runtime, __dirname is dist/__tests__/. Personas live at packages/loom-core/personas/.
const personasDir = path.resolve(__dirname, '..', '..', 'personas');

function readPersona(name: string): string {
  return fs.readFileSync(path.join(personasDir, name), 'utf8');
}

// ── Regression guard: key phrases must remain in both persona files ──────────
//
// This test asserts CONTENT PRESENCE only. The effectiveness of this guidance
// (i.e., whether the LLM actually emits cohesive single-file stories) is
// measured downstream by how rarely the serializer (story-028-002) has to fire
// on representative briefs — not by an assertion here.

describe('Persona guidance — file/module-boundary framing (story-028-003)', () => {
  describe('pm.md Task B (story-breakdown)', () => {
    let pm: string;
    it('can be read', () => {
      pm = readPersona('pm.md');
      assert.ok(pm.length > 0);
    });

    it('contains guidance to emit single-file-concentrated work as ONE story (AC-1)', () => {
      pm = readPersona('pm.md');
      assert.ok(
        pm.includes('single-file-concentrated') || pm.includes('Single-file-concentrated'),
        'pm.md must mention "single-file-concentrated" work',
      );
      assert.ok(
        pm.includes('tightly-coupled-region') || pm.includes('tightly-coupled-region'),
        'pm.md must mention "tightly-coupled-region" work',
      );
      assert.ok(
        pm.includes('independently-developable') || pm.includes('independently-developable'),
        'pm.md must mention "independently-developable" boundaries',
      );
    });

    it('contains the counter-caution against oversized stories (AC-3)', () => {
      pm = readPersona('pm.md');
      assert.ok(
        pm.includes('oversized story') || pm.includes('one oversized story'),
        'pm.md must contain the counter-caution against collapsing work into one oversized story',
      );
    });
  });

  describe('architect.md Task C (shared-contract)', () => {
    let arch: string;
    it('can be read', () => {
      arch = readPersona('architect.md');
      assert.ok(arch.length > 0);
    });

    it('contains guidance aligned to file/module-boundary framing (AC-2)', () => {
      arch = readPersona('architect.md');
      assert.ok(
        arch.includes('single-file-concentrated') || arch.includes('Single-file-concentrated'),
        'architect.md must mention "single-file-concentrated" work',
      );
      assert.ok(
        arch.includes('tightly-coupled-region'),
        'architect.md must mention "tightly-coupled-region" work',
      );
      assert.ok(
        arch.includes('independently-') ,
        'architect.md must reference independently-developable or independently-editable boundaries',
      );
    });

    it('contains the counter-caution against oversized stories (AC-3)', () => {
      arch = readPersona('architect.md');
      assert.ok(
        arch.includes('oversized story') || arch.includes('one oversized story'),
        'architect.md must contain the counter-caution against collapsing work into one oversized story',
      );
    });
  });
});
