import { Command } from 'commander';
import { CommandDescriptionSchema } from '../describe/schema.js';
import { collectSpecs } from '../describe/registry.js';
import { buildManifest } from '../describe/manifest.js';
import { applySpec } from '../describe/applySpec.js';
import { spec } from './describeSpec.js';
export { spec };

// Stored during registerDescribe so runDescribe can delegate to buildManifest.
let _program: Command | null = null;

// No arg: emits full ManifestSchema-valid JSON to stdout.
// With arg: emits the named CommandDescription JSON to stdout.
// Unknown name: writes error to stderr and sets exitCode=1.
export function runDescribe(commandName?: string): void {
  if (commandName === undefined) {
    const manifest = buildManifest(_program ?? new Command());
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const specs = collectSpecs();
  const found = specs.find((s) => s.name === commandName);
  if (!found) {
    console.error(`Unknown command: "${commandName}". Run \`loom describe\` to see all commands.`);
    process.exitCode = 1;
    return;
  }
  CommandDescriptionSchema.parse(found);
  console.log(JSON.stringify(found, null, 2));
}

export function registerDescribe(program: Command): void {
  _program = program;
  applySpec(program.command('describe', { hidden: true }), spec).action((commandName?: string) => {
    runDescribe(commandName);
  });
}
