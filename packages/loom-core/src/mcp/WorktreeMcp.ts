import fs from 'node:fs';
import path from 'node:path';
import type { McpRegistry } from './McpRegistry.js';
import { pickPackage, toMcpJsonEntry, type McpJsonEntry } from './adapter.js';

export interface MaterializeOptions {
  worktreePath: string;
  /** null = policy.mcp.registry unset → empty config. */
  registry: McpRegistry | null;
}

export interface MaterializeResult {
  /** Absolute path of the written .cursor/mcp.json. */
  configPath: string;
  /** Sorted server names. */
  serverNames: string[];
}

interface GeneratedMcpConfig {
  mcpServers: Record<string, McpJsonEntry>;
}

/**
 * Writes a worktree-local `.cursor/mcp.json` whose servers are EXACTLY the
 * policy registry contents. This is a whole-file overwrite — never a merge —
 * so the generated file is a pure function of the registry and re-dispatch is
 * idempotent. We deliberately do NOT reuse `upsertMcpServer`, which never
 * clobbers; any inherited `~/.cursor/mcp.json` servers are intentionally
 * dropped (migration path is `loom mcp add`).
 *
 * Secret inputs stay as `${VAR}` references — `toMcpJsonEntry` never resolves
 * or inlines a value.
 */
export function materializeWorktreeMcpConfig(
  opts: MaterializeOptions
): MaterializeResult {
  const mcpServers: Record<string, McpJsonEntry> = {};

  for (const def of opts.registry?.list() ?? []) {
    const pkg = pickPackage(def);
    if (!pkg) continue; // no installable package — nothing to expose
    mcpServers[def.name] = toMcpJsonEntry(pkg);
  }

  const config: GeneratedMcpConfig = { mcpServers };
  const cursorDir = path.join(opts.worktreePath, '.cursor');
  const configPath = path.join(cursorDir, 'mcp.json');

  fs.mkdirSync(cursorDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    configPath,
    serverNames: Object.keys(mcpServers).sort((a, b) => a.localeCompare(b)),
  };
}
