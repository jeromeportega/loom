import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ManifestSchema } from '../describe/schema.js';
import type { CommandDescription } from '../describe/schema.js';
import { collectSpecs } from '../describe/registry.js';
import { WORKFLOWS } from '../describe/workflows.js';
import { applySpec } from '../describe/applySpec.js';

export const spec: CommandDescription = {
  name: 'describe',
  summary: 'Emit the CLI self-description manifest as JSON',
  whenToUse:
    'Use when an agent or tool needs the full machine-readable manifest of every loom command and encoded task workflows, or when looking up the contract for a single command by name.',
  arguments: [
    {
      name: 'command',
      type: 'string',
      required: false,
      description: 'Command name to describe — full path for subcommands (e.g. "guard check")',
    },
  ],
  options: [],
  output: {
    text: 'Full manifest JSON (ManifestSchema) or single-command description JSON (CommandDescriptionSchema)',
    json: { supported: true, shape: 'Manifest | CommandDescription' },
  },
  examples: [
    { command: 'loom describe', description: 'Emit the full CLI manifest as JSON' },
    { command: 'loom describe status', description: 'Emit the status command description as JSON' },
    {
      command: 'loom describe "guard check"',
      description: 'Emit the guard check subcommand description as JSON',
    },
  ],
  exitCodes: [
    { code: 0, meaning: 'Manifest or command description emitted to stdout' },
    { code: 1, meaning: 'Unknown command name — message written to stderr' },
  ],
  errors: ['Unknown command name — use the exact full path (e.g. "guard check", "mcp add")'],
  relationships: { prerequisites: [], nextSteps: ['status', 'run'] },
};

// No arg: emits full ManifestSchema-valid JSON to stdout.
// With arg: emits the named CommandDescription JSON to stdout.
// Unknown name: writes error to stderr and sets exitCode=1.
export function runDescribe(commandName?: string): void {
  const specs = collectSpecs();

  if (commandName === undefined) {
    const loomVersion = (
      JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;

    const manifest = ManifestSchema.parse({
      loomVersion,
      source: 'live-commander-registry',
      commands: specs,
      workflows: WORKFLOWS,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const found = specs.find((s) => s.name === commandName);
  if (!found) {
    console.error(`Unknown command: "${commandName}". Run \`loom describe\` to see all commands.`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(found, null, 2));
}

export function registerDescribe(program: Command): void {
  applySpec(program.command('describe'), spec).action((commandName?: string) => {
    runDescribe(commandName);
  });
}
