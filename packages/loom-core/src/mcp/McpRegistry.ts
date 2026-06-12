import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';

// ─── server.json schema (the agentskills-style MCP registry format) ─────────

const ServerVarSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  is_required: z.boolean().default(false),
  is_secret: z.boolean().default(false),
});

const TransportSchema = z.object({
  type: z.string(),
  url: z.string().optional(),
  headers: z.array(ServerVarSchema).optional(),
});

const PackageSchema = z.object({
  registry_type: z.string().default('npm'),
  identifier: z.string(),
  version: z.string().default(''),
  transport: TransportSchema,
  environment_variables: z.array(ServerVarSchema).optional(),
});

const ServerJsonSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  packages: z.array(PackageSchema).default([]),
});

// ─── Normalized types consumers work with ──────────────────────────────────

export type McpTransportType = 'stdio' | 'streamable-http';

/** A required input declared by a server — an env var (stdio) or header (http). */
export interface McpRequirement {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  kind: 'env' | 'header';
}

export interface McpPackage {
  registryType: string;
  identifier: string;
  version: string;
  transportType: McpTransportType;
  /** Present for streamable-http packages. */
  url?: string;
  requirements: McpRequirement[];
}

export interface McpServerDef {
  name: string;
  description: string;
  packages: McpPackage[];
}

/**
 * Reads an org's approved-MCP registry — a directory of `servers/<name>/server.json`
 * files (e.g. a checkout of an `awesome/mcp`-style registry repo). The registry path is
 * configurable (`policy.mcp.registry`); loom ships no built-in registry, staying
 * open-source-generic.
 */
export class McpRegistry {
  constructor(private registryPath: string) {}

  /** Parsed server definitions. Malformed `server.json` files are skipped. */
  list(): McpServerDef[] {
    const serversDir = path.join(this.registryPath, 'servers');
    if (!fs.existsSync(serversDir)) return [];

    const files = fg.sync('*/server.json', { cwd: serversDir, absolute: true });
    const defs: McpServerDef[] = [];
    for (const file of files) {
      const def = parseServerJson(file);
      if (def) defs.push(def);
    }
    return defs.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpServerDef | undefined {
    return this.list().find((d) => d.name === name);
  }
}

function parseServerJson(file: string): McpServerDef | null {
  let parsed: z.infer<typeof ServerJsonSchema>;
  try {
    parsed = ServerJsonSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null; // malformed — skip
  }

  return {
    name: parsed.name,
    description: parsed.description,
    packages: parsed.packages.map((pkg) => {
      const transportType: McpTransportType =
        pkg.transport.type === 'streamable-http' ? 'streamable-http' : 'stdio';
      const requirements: McpRequirement[] = [
        ...(pkg.environment_variables ?? []).map((v) => ({
          name: v.name,
          description: v.description,
          required: v.is_required,
          secret: v.is_secret,
          kind: 'env' as const,
        })),
        ...(pkg.transport.headers ?? []).map((h) => ({
          name: h.name,
          description: h.description,
          required: h.is_required,
          secret: h.is_secret,
          kind: 'header' as const,
        })),
      ];
      return {
        registryType: pkg.registry_type,
        identifier: pkg.identifier,
        version: pkg.version,
        transportType,
        url: pkg.transport.url,
        requirements,
      };
    }),
  };
}
