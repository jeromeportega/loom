import * as readline from 'node:readline';
import type { IntakeVerdict } from '@loom-ai/core';

const TYPE_VALUES = ['feature', 'bug', 'chore'] as const;
const SIZE_VALUES = ['story', 'epic'] as const;

type TypeValue = (typeof TYPE_VALUES)[number];
type SizeValue = (typeof SIZE_VALUES)[number];

export interface ConfirmRoutingOpts {
  input?: NodeJS.ReadableStream;
  out?: NodeJS.WritableStream;
}

/**
 * Interactive CLI checkpoint for `intake_routing=confirm`.
 * Prints the classification surface, prompts the operator to accept or
 * override type/size, and returns the final decision.
 *
 * Overrides are constrained to the verdict enums; confidence and rationale
 * are NOT editable — no prompt path mutates them.
 *
 * Must only be called when process.stdin.isTTY is true (caller's responsibility).
 * Inject `opts.input`/`opts.out` for testability — never passes a real TTY in tests.
 */
export async function confirmRouting(
  verdict: IntakeVerdict,
  opts?: ConfirmRoutingOpts,
): Promise<{
  decision: 'accepted' | 'overridden';
  type: TypeValue;
  size: SizeValue;
}> {
  const out = opts?.out ?? process.stdout;
  const input = opts?.input ?? process.stdin;

  out.write(`\n  Intake classification: ${verdict.type} / ${verdict.size} (confidence: ${verdict.confidence})\n`);
  out.write(`  Rationale: ${verdict.rationale}\n\n`);

  const rl = readline.createInterface({ input, terminal: false });
  // Use the async iterator so all buffered lines are available even after
  // readline has seen EOF on the input stream. Without this, calling
  // rl.question() after the stream ends throws ERR_USE_AFTER_CLOSE.
  const iter = rl[Symbol.asyncIterator]();

  const askLine = async (prompt: string): Promise<string> => {
    out.write(prompt);
    const { value, done } = await iter.next();
    return done ? '' : (value ?? '');
  };

  try {
    const raw = await askLine('  Accept this classification? ([a]ccept / [o]verride): ');
    const choice = raw.trim().toLowerCase();

    if (!choice || choice === 'a' || choice === 'accept' || choice === 'y' || choice === 'yes') {
      return { decision: 'accepted', type: verdict.type, size: verdict.size };
    }

    // Override path — constrain to enum values only
    const type = await promptEnum(askLine, out, 'type', TYPE_VALUES, verdict.type);
    const size = await promptEnum(askLine, out, 'size', SIZE_VALUES, verdict.size);

    const changed = type !== verdict.type || size !== verdict.size;
    return {
      decision: changed ? 'overridden' : 'accepted',
      type,
      size,
    };
  } finally {
    rl.close();
  }
}

async function promptEnum<T extends string>(
  askLine: (prompt: string) => Promise<string>,
  out: NodeJS.WritableStream,
  field: string,
  values: readonly T[],
  current: T,
): Promise<T> {
  for (;;) {
    const raw = await askLine(`  Override ${field}? [${values.join('/')}] (enter to keep '${current}'): `);
    const trimmed = raw.trim();
    if (!trimmed) return current;
    if ((values as readonly string[]).includes(trimmed)) return trimmed as T;
    out.write(`  Invalid ${field}: '${trimmed}'. Must be one of: ${values.join(', ')}\n`);
  }
}
