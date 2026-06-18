import { z } from 'zod';

export const ArgTypeSchema = z.enum(['string', 'number', 'boolean', 'enum']);
export type ArgType = z.infer<typeof ArgTypeSchema>;

export const PositionalArgSchema = z.object({
  name: z.string().min(1),
  type: ArgTypeSchema,
  required: z.boolean(),
  description: z.string().min(1),
  values: z.array(z.string()).optional(),
}).refine(
  (arg) => arg.type !== 'enum' || (arg.values !== undefined && arg.values.length > 0),
  { message: 'enum type requires a non-empty values array', path: ['values'] }
).refine(
  (arg) => arg.type === 'enum' || arg.values === undefined,
  { message: 'values may only be set when type is enum', path: ['values'] }
);
export type PositionalArg = z.infer<typeof PositionalArgSchema>;

export const OptionFlagSchema = z.object({
  name: z.string().regex(/^--[a-z][a-z0-9-]*$/, {
    message: 'option name must match ^--[a-z][a-z0-9-]*$',
  }),
  type: ArgTypeSchema,
  default: z.unknown().optional(),
  description: z.string().min(1),
  changesOutputShape: z.boolean(),
});
export type OptionFlag = z.infer<typeof OptionFlagSchema>;

export const OutputContractSchema = z.object({
  text: z.string().min(1),
  json: z.object({
    supported: z.boolean(),
    shape: z.string().optional(),
  }).optional(),
});
export type OutputContract = z.infer<typeof OutputContractSchema>;

export const UsageExampleSchema = z.object({
  command: z.string().min(1),
  description: z.string().min(1),
});
export type UsageExample = z.infer<typeof UsageExampleSchema>;

export const ExitCodeSchema = z.object({
  code: z.number().int(),
  meaning: z.string().min(1),
});
export type ExitCode = z.infer<typeof ExitCodeSchema>;

export const RelationshipsSchema = z.object({
  prerequisites: z.array(z.string()).default([]),
  nextSteps: z.array(z.string()).default([]),
});
export type Relationships = z.infer<typeof RelationshipsSchema>;

export const CommandDescriptionSchema = z.object({
  name: z.string().min(1),
  summary: z.string().min(5).max(100),
  whenToUse: z.string().min(1),
  arguments: z.array(PositionalArgSchema),
  options: z.array(OptionFlagSchema),
  output: OutputContractSchema,
  examples: z.array(UsageExampleSchema).min(1),
  exitCodes: z.array(ExitCodeSchema).min(1),
  errors: z.array(z.string()),
  relationships: RelationshipsSchema.default({ prerequisites: [], nextSteps: [] }),
  /** absent/undefined === 'operator' (visible in capabilities docs and coverage checks) */
  audience: z.enum(['operator', 'internal']).optional(),
  /** extra tokens the capabilities page may legitimately use for this command */
  aliases: z.array(z.string()).optional(),
});
export type CommandDescription = z.infer<typeof CommandDescriptionSchema>;

export const WorkflowStepSchema = z.object({
  command: z.string().min(1),
  why: z.string().min(1),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const WorkflowSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message: 'workflow id must match ^[a-z][a-z0-9-]*$',
  }),
  goal: z.string().min(1),
  steps: z.array(WorkflowStepSchema).min(1),
});
export type Workflow = z.infer<typeof WorkflowSchema>;

export const ManifestSchema = z.object({
  loomVersion: z.string().min(1),
  source: z.literal('live-commander-registry'),
  commands: z.array(CommandDescriptionSchema).min(1),
  workflows: z.array(WorkflowSchema).min(1),
});
export type Manifest = z.infer<typeof ManifestSchema>;
