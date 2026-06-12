/**
 * Parses a shell command string into its constituent parts for policy evaluation.
 * Handles simple quoting and flag extraction without a full shell interpreter.
 */

export interface ParsedCommand {
  argv: string[];
  program: string;
  subcommand: string | null;
  flags: string[];
  args: string[];
}

export function parseCommand(raw: string): ParsedCommand {
  const argv = shellSplit(raw.trim());
  if (argv.length === 0) {
    return { argv: [], program: '', subcommand: null, flags: [], args: [] };
  }

  const program = argv[0];
  const rest = argv.slice(1);

  // First non-flag argument is the subcommand
  const subcommand = rest.find((t) => !t.startsWith('-')) ?? null;
  const flags = rest.filter((t) => t.startsWith('-'));
  const args = rest.filter((t) => !t.startsWith('-'));

  return { argv, program, subcommand, flags, args };
}

// Minimal POSIX-ish shell word splitter (handles single/double quotes and backslash)
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      i++;
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < input.length && input[i] !== "'") {
        current += input[i++];
      }
      i++; // closing quote
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          current += input[++i];
          i++;
        } else {
          current += input[i++];
        }
      }
      i++; // closing quote
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}
