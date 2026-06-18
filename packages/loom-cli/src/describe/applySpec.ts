import type { Command } from 'commander';
import type { CommandDescription } from './schema.js';

/**
 * Applies spec.summary -> cmd.description(); spec.arguments -> cmd.argument();
 * spec.options -> cmd.option(). Returns cmd for chaining .action().
 */
export function applySpec(cmd: Command, spec: CommandDescription): Command {
  cmd.description(spec.summary);

  for (const arg of spec.arguments) {
    const argStr = arg.required ? `<${arg.name}>` : `[${arg.name}]`;
    cmd.argument(argStr, arg.description);
  }

  for (const opt of spec.options) {
    const hasValue = opt.type !== 'boolean';
    const flag = hasValue ? `${opt.name} <value>` : opt.name;
    if (opt.default !== undefined) {
      cmd.option(flag, opt.description, opt.default as string);
    } else {
      cmd.option(flag, opt.description);
    }
  }

  return cmd;
}
