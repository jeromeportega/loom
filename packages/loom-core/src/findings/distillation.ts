import { z } from 'zod';

/**
 * Output of the doc-distiller skill (story-005): a compacted worker context
 * plus the token accounting and the acceptance criteria that must survive
 * distillation verbatim. The context assembler throws if any preserved AC is
 * not found in the distilled text, so this array is the verification contract.
 */
export const Distillation = z.object({
  distilled: z.string().min(1),
  source_token_count: z.number().int().nonnegative(),
  distilled_token_count: z.number().int().nonnegative(),
  acceptance_criteria_preserved: z.array(z.string()),
});
export type Distillation = z.infer<typeof Distillation>;
