import fs from 'node:fs';
import path from 'node:path';

export type UpsertResult = 'created' | 'added' | 'exists';

/**
 * Merges a server entry into an mcp.json-style file under `mcpServers`.
 * Never clobbers other servers; skips if the named server already exists.
 * Shared by `loom init` (the loom server) and `loom mcp add` (registry servers).
 */
export function upsertMcpServer(
  mcpPath: string,
  serverName: string,
  entry: unknown
): UpsertResult {
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });

  const fileExisted = fs.existsSync(mcpPath);
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (fileExisted) {
    try {
      config = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    } catch {
      config = {}; // malformed — start fresh
    }
  }

  const servers = config.mcpServers ?? {};
  if (servers[serverName]) {
    return 'exists';
  }
  servers[serverName] = entry;
  config.mcpServers = servers;
  fs.writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n');
  return fileExisted ? 'added' : 'created';
}
