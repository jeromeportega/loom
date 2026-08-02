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
      // bash deletes a backslash-newline (line continuation) and JOINS the
      // surrounding text into one token — it is NOT a literal char. Embedding the
      // newline here would split `gi\<nl>t` into a bogus token and mask the real
      // program name from every downstream check.
      if (input[i + 1] === '\n') { i += 2; continue; }
      if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 3; continue; }
      current += input[++i];
      i++;
      continue;
    }

    // ANSI-C quoting $'...' — one word; backslash escapes the next char and the
    // string ends at the first UNESCAPED "'". Mirror stripQuoted() so a stray "'"
    // can't desync the split and mis-identify the program for the git/rm checks.
    // (An escaped `\$'…'` is consumed by the backslash branch above.)
    if (ch === '$' && input[i + 1] === "'") {
      i += 2; // consume `$` and the opening `'`
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) {
          current += input[i + 1];
          i += 2;
        } else {
          current += input[i++];
        }
      }
      i++; // closing `'`
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
          // Backslash-newline is a line continuation inside "…" too (deleted+joined).
          if (input[i + 1] === '\n') { i += 2; continue; }
          if (input[i + 1] === '\r' && input[i + 2] === '\n') { i += 3; continue; }
          current += input[++i];
          i++;
        } else {
          current += input[i++];
        }
      }
      i++; // closing quote
      continue;
    }

    // Newline/CR are word separators too (defense in depth: the metacharacter
    // check in check() rejects unquoted newlines before this runs, but other
    // entry points — e.g. read-scope — parse without that pre-check, so a raw
    // newline must not glue two tokens into one and mask the real program name).
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
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
