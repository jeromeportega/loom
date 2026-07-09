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
reconcile, migrate, cost) that represent common operator patterns. Each step's
`command` field must exactly match a `CommandDescription.name` from
`collectSpecs()`.

### Key operator sequences

| Sequence | Commands | Notes |
|---|---|---|
| **Standard epic** | `loom weave` → `loom approve` → `loom run` → `loom status` | The canonical planning-to-execution loop |
| **Cross-repo epic** | same as standard, but stories carry `repo: <slug>` | `loom run` partitions per-repo stages in topological order; one PR per repo |
| **Migrate to loom-home** | loom migrate [--dry-run] | Ensures loom-home exists, migrates DB + planning scratch, registers repo in workspace manifest (`<loom-home>/workspace.yaml`). Idempotent. Internal command; new installs skip this — `loom init` handles it automatically. |
| **Cost inspection** | `loom cost [--epic <id>] [--aggregate] [--json]` | Read-only: per-phase cost, token, and wall-time breakdown; cross-run statistics with `--aggregate`. Never mutates state. |
| **Stall recovery** | `loom stop` / `loom retry <story-id>` | Loom auto-retries stalled workers up to `policy.agents.stall_recovery_budget` times (default 2); once exhausted, surfaces for manual `loom retry`. |
| **Standalone story** | `loom weave "<brief>"` (with `policy.agents.intake_routing` set to `advisory`) | Lightweight path for story-sized briefs: no PM/PRD, no decomposition; produces one PR under a `story-NNN` id. |

### Cross-repo execution

When an epic spans multiple registered repositories, set `repo: <slug>` on
individual stories in the epic YAML. `loom run` coordinates work across all
registered repos — stored in the workspace manifest (`<loom-home>/workspace.yaml`,
written by `loom init`) — dispatching per-repo stages in topological dependency
order. A `CommandDescription` for cross-repo-aware commands should document the
`repo` field and the `loom init` workspace-registration prerequisite in its
`relationships.prerequisites` list.

## The manifest

The `describe` subcommand assembles a `Manifest` — `{ loomVersion, source, commands, workflows }`
— by calling `buildManifest(program)`. The manifest is validated against
`ManifestSchema` before emission. `source` is always the literal
`'live-commander-registry'` to mark that the data came from the live
Commander registration, not a static file.
