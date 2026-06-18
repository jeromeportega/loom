import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  PolicyEngine,
  McpRegistry,
  pickPackage,
  toMcpJsonEntry,
  requiredSecrets,
} from '@loom-ai/core';

type UpsertResult = 'created' | 'added' | 'exists';

function upsertMcpServer(
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
      config = {};
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

function loadRegistry(): McpRegistry | null {
  const loomDir = path.join(process.cwd(), '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  const policy = PolicyEngine.load(loomDir).policyData;
  if (!policy.mcp.registry) {
    console.log('\n  No MCP registry configured.');
    console.log('  Point `policy.mcp.registry` at a checkout of your org\'s MCP');
    console.log('  registry (a directory of servers/<name>/server.json files).\n');
    return null;
  }
  return new McpRegistry(policy.mcp.registry);
}

export function runMcpList(): void {
  const registry = loadRegistry();
  if (!registry) return;

  const servers = registry.list();
  if (servers.length === 0) {
    console.log('\n  The configured MCP registry has no servers.\n');
    return;
  }
  console.log(`\n  ${servers.length} approved MCP server(s):\n`);
  for (const server of servers) {
    console.log(`  ${server.name}`);
    console.log(`    ${server.description}`);
  }
  console.log('\n  Add one with: loom mcp add <name>\n');
}

export function runMcpAdd(name: string): void {
  const registry = loadRegistry();
  if (!registry) return;

  const server = registry.get(name);
  if (!server) {
    console.error(`MCP server "${name}" not found in the registry. Try \`loom mcp list\`.`);
    process.exit(1);
  }

  const pkg = pickPackage(server);
  if (!pkg) {
    console.error(`MCP server "${name}" has no installable package.`);
    process.exit(1);
  }

  const entry = toMcpJsonEntry(pkg);
  const projectRoot = process.cwd();

  for (const [rel, label] of [
    ['.mcp.json', '.mcp.json'],
    ['.cursor/mcp.json', '.cursor/mcp.json'],
  ] as const) {
    const result = upsertMcpServer(path.join(projectRoot, rel), server.name, entry);
    console.log(`  ${result === 'exists' ? 'exists ' : 'added  '} ${label}  (${server.name})`);
  }

  const secrets = requiredSecrets(pkg);
  if (secrets.length > 0) {
    console.log('\n  This server needs the following secrets — set them yourself');
    console.log('  (loom never stores credential values):\n');
    for (const s of secrets) {
      console.log(`    ${s.name}  — ${s.description || '(no description)'}`);
    }
  }
  console.log('');
}

export const specList: CommandDescription = {
  name: 'mcp list',
  summary: 'List approved MCP servers from the configured registry',
  whenToUse: 'Use to see which MCP servers are available in your org registry before adding one.',
  arguments: [],
  options: [],
  output: { text: 'List of approved MCP server names with descriptions' },
  examples: [
    { command: 'loom mcp list', description: 'List all approved MCP servers in the registry' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Servers listed successfully' },
    { code: 1, meaning: 'No registry configured or loom not initialized' },
  ],
  errors: ['No MCP registry configured — set policy.mcp.registry', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['init'], nextSteps: ['mcp add'] },
};

export const specAdd: CommandDescription = {
  name: 'mcp add',
  summary: 'Add an approved MCP server to .mcp.json and .cursor/mcp.json',
  whenToUse: 'Use to provision an approved MCP server from the org registry into the project.',
  arguments: [
    { name: 'name', type: 'string', required: true, description: 'Registry server name to add' },
  ],
  options: [],
  output: { text: 'Confirmation of which config files were updated plus required secrets if any' },
  examples: [
    { command: 'loom mcp add my-server', description: 'Add the "my-server" MCP server to both .mcp.json and .cursor/mcp.json' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Server added (or already present) successfully' },
    { code: 1, meaning: 'Server not found in registry or loom not initialized' },
  ],
  errors: ['MCP server not found in registry — try `loom mcp list`', 'No installable package for this server', 'loom is not initialized — run `loom init` first'],
  relationships: { prerequisites: ['mcp list'], nextSteps: [] },
};
