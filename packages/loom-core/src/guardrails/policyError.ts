import type { ZodError } from 'zod';

/** One invalid knob, read off a single ZodError.issues[] entry. No new validation. */
export interface PolicyIssue {
  fieldPath: string;     // dotted path, e.g. "agents.review_strategy"
  received: unknown;     // the value the operator wrote
  constraint: string;    // human render of allowed values / bound,
                         //   e.g. "one of: off, comment, block-and-revise"
  hint: string;          // one-line fix, e.g.
                         //   "Set agents.review_strategy to one of the allowed values."
}

/** Thrown by PolicyEngine.load on a *validation* failure (not parse/IO).
 *  .message is the full multi-line FR-1 render; .issues is the structured form. */
export class PolicyValidationError extends Error {
  readonly policyPath: string;
  readonly issues: PolicyIssue[];

  constructor(policyPath: string, issues: PolicyIssue[]) {
    super(formatPolicyError(policyPath, issues));
    this.name = 'PolicyValidationError';
    this.policyPath = policyPath;
    this.issues = issues;
  }
}

/** Map each zod issue by issue.code into a PolicyIssue. Adds NO validation. */
export function describePolicyIssues(err: ZodError): PolicyIssue[] {
  return err.issues.map((issue) => {
    const fieldPath = issue.path.join('.');
    const received = (issue as { received?: unknown }).received;

    let constraint: string;
    let hint: string;

    if (issue.code === 'invalid_enum_value') {
      const options = issue.options.join(', ');
      constraint = `one of: ${options}`;
      hint = `Set ${fieldPath} to one of the allowed values: ${options}.`;
    } else if (issue.code === 'too_small') {
      const min = issue.minimum;
      const type = issue.type === 'number' ? 'integer' : issue.type;
      constraint = `${type} >= ${min}`;
      hint = `Set ${fieldPath} to a value of at least ${min}.`;
    } else if (issue.code === 'too_big') {
      const max = issue.maximum;
      const type = issue.type === 'number' ? 'integer' : issue.type;
      constraint = `${type} <= ${max}`;
      hint = `Set ${fieldPath} to a value of at most ${max}.`;
    } else {
      constraint = issue.message;
      hint = `Fix the value at ${fieldPath}: ${issue.message}.`;
    }

    return { fieldPath, received, constraint, hint };
  });
}

/** The single FR-1/FR-4 render — names the file path, then each field/received/
 *  constraint/hint. Both the load boundary and the doctor call this. */
export function formatPolicyError(policyPath: string, issues: PolicyIssue[]): string {
  const lines: string[] = [
    `Policy validation failed: ${policyPath}`,
    '',
  ];

  for (const issue of issues) {
    lines.push(`  Field:      ${issue.fieldPath}`);
    lines.push(`  Received:   ${JSON.stringify(issue.received)}`);
    lines.push(`  Constraint: ${issue.constraint}`);
    lines.push(`  Fix:        ${issue.hint}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
