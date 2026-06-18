import type { CommandDescription } from '../describe/schema.js';

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
