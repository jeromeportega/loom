import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ManifestSchema } from './schema.js';
import type { Manifest } from './schema.js';
import { collectSpecs, enumerateRegisteredCommands } from './registry.js';
import { WORKFLOWS } from './workflows.js';

// Cross-checks enumerateRegisteredCommands(program) against collectSpecs(),
// assembles { loomVersion, source:'live-commander-registry', commands, workflows },
// validates against ManifestSchema, returns it. Throws ZodError on any invalid spec.
export function buildManifest(program: Command): Manifest {
  const loomVersion = (
    JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  const specs = collectSpecs();
  const registered = enumerateRegisteredCommands(program); // includes hidden

  // Invariant: every registered command (visible OR hidden) must have a spec in collectSpecs()
  if (registered.length > 0) {
    const specNames = new Set(specs.map((s) => s.name));
    const unregistered = registered.filter((name) => !specNames.has(name));
    if (unregistered.length > 0) {
      // Fail closed: every registered command must have a spec in collectSpecs() before reaching production.
      throw new Error(
        `[loom describe] registered commands without specs: ${unregistered.join(', ')}`
      );
    }
  }

  // Manifest output: operator-audience only (hidden/internal commands excluded)
  const operatorSpecs = specs.filter((s) => (s.audience ?? 'operator') === 'operator');

  return ManifestSchema.parse({
    loomVersion,
    source: 'live-commander-registry',
    commands: operatorSpecs,
    workflows: WORKFLOWS,
  });
}
