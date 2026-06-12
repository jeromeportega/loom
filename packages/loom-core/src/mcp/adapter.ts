import type { McpPackage, McpServerDef, McpRequirement } from './McpRegistry.js';

export interface McpJsonStdioEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}
export interface McpJsonHttpEntry {
  url: string;
  headers: Record<string, string>;
}
export type McpJsonEntry = McpJsonStdioEntry | McpJsonHttpEntry;

/**
 * Picks the package to provision from a server definition. Prefers stdio (no
 * hosted endpoint needed) over streamable-http.
 */
export function pickPackage(def: McpServerDef): McpPackage | undefined {
  return (
    def.packages.find((p) => p.transportType === 'stdio') ?? def.packages[0]
  );
}

/**
 * Converts a registry package into an `.mcp.json` server entry. Declared inputs
 * become environment-variable REFERENCES (`${NAME}`) — loom never reads,
 * prompts for, or stores a secret value.
 */
export function toMcpJsonEntry(pkg: McpPackage): McpJsonEntry {
  if (pkg.transportType === 'streamable-http') {
    const headers: Record<string, string> = {};
    for (const r of pkg.requirements) {
      if (r.kind === 'header') headers[r.name] = `\${${r.name}}`;
    }
    return { url: pkg.url ?? '', headers };
  }

  const env: Record<string, string> = {};
  for (const r of pkg.requirements) {
    if (r.kind === 'env') env[r.name] = `\${${r.name}}`;
  }
  const ref = pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
  return { command: 'npx', args: ['-y', ref], env };
}

/** The secret inputs a user must set in their own environment for this package. */
export function requiredSecrets(pkg: McpPackage): McpRequirement[] {
  return pkg.requirements.filter((r) => r.secret);
}
