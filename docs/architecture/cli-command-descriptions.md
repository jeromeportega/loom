# CLI command description standard

Every loom CLI command has a machine-readable description that doubles as
runtime documentation and agent guidance. This page explains the standard,
where the schema lives, and how to write a conforming spec.

## Where the schema lives

| File | Purpose |
|---|---|
| `packages/loom-cli/src/describe/schema.ts` | **Source of truth** — zod schemas + inferred TypeScript types |
| `schemas/cli-description.schema.yaml` | Human-readable JSON Schema draft-07 mirror (hand-synced; no codegen) |

The zod module is authoritative. The YAML is a readable reference; do not
load it at runtime. When you change the zod schemas, update the YAML in
the same PR.

## The `CommandDescription` shape

```typescript
type CommandDescription = {
  name: string;            // full registered path: "status", "guard check"
  summary: string;         // 5–100 chars; fed into Commander .description()
  whenToUse: string;       // agent-facing guidance
  arguments: PositionalArg[];
  options: OptionFlag[];
  output: OutputContract;
  examples: UsageExample[];   // min 1 required
  exitCodes: ExitCode[];      // min 1 required
  errors: string[];
  relationships: Relationships;  // defaults to { prerequisites: [], nextSteps: [] }
};
```

### Key field constraints

**`summary`** — 5 to 100 characters. Fed directly into Commander's
`.description()` so it appears in `--help` output. One sentence.

**`options[].name`** — must match `^--[a-z][a-z0-9-]*$`. Long-form only;
no short flags here.

**`options[].changesOutputShape`** — set `true` when the flag alters the
*structure* of the output (e.g. `--json` switches from a human table to
a JSON payload). Set `false` for flags that filter but keep the same shape.

**`arguments[].values`** — required when `type` is `'enum'`, forbidden
otherwise.

**`examples`** — at least one entry is required. Write copy-paste-ready
shell invocations.

**`exitCodes`** — at least one entry is required. Always include code `0`
(success).

**`relationships`** — optional; defaults to empty arrays. List command
names (matching `CommandDescription.name`) that typically precede or
follow this command.

## Writing a spec

Create `export const spec: CommandDescription` in the command file
(`packages/loom-cli/src/commands/<name>.ts`) and validate it against
`CommandDescriptionSchema`:

```typescript
import { z } from 'zod';
import { CommandDescriptionSchema, type CommandDescription } from '../describe/schema.js';

export const spec: CommandDescription = CommandDescriptionSchema.parse({
  name: 'my-command',
  summary: 'Do the thing',
  whenToUse: 'Use when you need the thing done.',
  arguments: [],
  options: [
    { name: '--json', type: 'boolean', description: 'Emit JSON', changesOutputShape: true },
  ],
  output: { text: 'Human-readable result' },
  examples: [{ command: 'loom my-command', description: 'Run with defaults' }],
  exitCodes: [{ code: 0, meaning: 'Success' }],
  errors: [],
  relationships: { prerequisites: [], nextSteps: [] },
});
```

Using `CommandDescriptionSchema.parse()` (not a plain object literal)
ensures the spec is validated at module load time and surfaces any
conformance errors immediately.

## Validation error format

On a `ZodError`, format issues with the repo's established pattern
(see `packages/loom-core/src/planner/PMAgent.ts:140`):

```typescript
err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
```

This produces path-qualified messages like:

```
examples: Array must contain at least 1 element(s)
options.0.name: option name must match ^--[a-z][a-z0-9-]*$
```

## Workflows

`packages/loom-cli/src/describe/workflows.ts` exports `WORKFLOWS: Workflow[]`
— a fixed set of multi-step sequences (plan, approve, run, status, retry,
reconcile) that represent common operator patterns. Each step's `command`
field must exactly match a `CommandDescription.name` from `collectSpecs()`.

## The manifest

`loom describe` assembles a `Manifest` — `{ loomVersion, source, commands, workflows }`
— by calling `buildManifest(program)`. The manifest is validated against
`ManifestSchema` before emission. `source` is always the literal
`'live-commander-registry'` to mark that the data came from the live
Commander registration, not a static file.
