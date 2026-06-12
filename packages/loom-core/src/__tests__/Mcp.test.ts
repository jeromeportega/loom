import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpRegistry } from '../mcp/McpRegistry.js';
import { toMcpJsonEntry, pickPackage, requiredSecrets } from '../mcp/adapter.js';
import type { McpJsonStdioEntry, McpJsonHttpEntry } from '../mcp/adapter.js';

let registryPath: string;

function writeServer(name: string, serverJson: object): void {
  const dir = path.join(registryPath, 'servers', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(serverJson));
}

const STDIO_SERVER = {
  name: 'jira-mcp',
  description: 'Jira integration',
  packages: [
    {
      registry_type: 'npm',
      identifier: '@org/jira-mcp',
      version: '2.0.0',
      transport: { type: 'stdio' },
      environment_variables: [
        { name: 'JIRA_TOKEN', description: 'A token', is_required: true, is_secret: true },
        { name: 'JIRA_URL', description: 'The base URL', is_required: true, is_secret: false },
      ],
    },
  ],
};

const HTTP_SERVER = {
  name: 'hosted-mcp',
  description: 'A hosted MCP server',
  packages: [
    {
      registry_type: 'npm',
      identifier: '@org/hosted-mcp',
      version: '1.0.0',
      transport: {
        type: 'streamable-http',
        url: 'https://mcp.example.com/mcp',
        headers: [{ name: 'X-API-KEY', description: 'key', is_required: true, is_secret: true }],
      },
    },
  ],
};

beforeEach(() => {
  registryPath = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mcp-reg-'));
});

afterEach(() => {
  fs.rmSync(registryPath, { recursive: true, force: true });
});

// ─── McpRegistry ────────────────────────────────────────────────────────────

describe('McpRegistry', () => {
  it('lists servers from server.json files', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    writeServer('hosted-mcp', HTTP_SERVER);
    const servers = new McpRegistry(registryPath).list();
    assert.equal(servers.length, 2);
    assert.deepEqual(
      servers.map((s) => s.name).sort(),
      ['hosted-mcp', 'jira-mcp']
    );
  });

  it('normalizes env vars and headers into requirements', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const pkg = new McpRegistry(registryPath).get('jira-mcp')!.packages[0];
    assert.equal(pkg.transportType, 'stdio');
    assert.equal(pkg.requirements.length, 2);
    const token = pkg.requirements.find((r) => r.name === 'JIRA_TOKEN');
    assert.equal(token?.secret, true);
    assert.equal(token?.kind, 'env');
  });

  it('reads streamable-http transport with header requirements', () => {
    writeServer('hosted-mcp', HTTP_SERVER);
    const pkg = new McpRegistry(registryPath).get('hosted-mcp')!.packages[0];
    assert.equal(pkg.transportType, 'streamable-http');
    assert.equal(pkg.url, 'https://mcp.example.com/mcp');
    assert.equal(pkg.requirements[0].kind, 'header');
  });

  it('skips a malformed server.json instead of crashing', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const badDir = path.join(registryPath, 'servers', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'server.json'), '{ not valid json');
    const servers = new McpRegistry(registryPath).list();
    assert.equal(servers.length, 1);
    assert.equal(servers[0].name, 'jira-mcp');
  });

  it('returns an empty list when the registry has no servers dir', () => {
    assert.deepEqual(new McpRegistry(registryPath).list(), []);
  });
});

// ─── adapter ────────────────────────────────────────────────────────────────

describe('mcp adapter', () => {
  it('converts a stdio package to an npx .mcp.json entry with env references', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const pkg = new McpRegistry(registryPath).get('jira-mcp')!.packages[0];
    const entry = toMcpJsonEntry(pkg) as McpJsonStdioEntry;
    assert.equal(entry.command, 'npx');
    assert.deepEqual(entry.args, ['-y', '@org/jira-mcp@2.0.0']);
    // Secret values are never embedded — only ${NAME} references.
    assert.equal(entry.env.JIRA_TOKEN, '${JIRA_TOKEN}');
    assert.equal(entry.env.JIRA_URL, '${JIRA_URL}');
  });

  it('converts a streamable-http package to a url + headers entry', () => {
    writeServer('hosted-mcp', HTTP_SERVER);
    const pkg = new McpRegistry(registryPath).get('hosted-mcp')!.packages[0];
    const entry = toMcpJsonEntry(pkg) as McpJsonHttpEntry;
    assert.equal(entry.url, 'https://mcp.example.com/mcp');
    assert.equal(entry.headers['X-API-KEY'], '${X-API-KEY}');
  });

  it('pickPackage prefers a stdio package', () => {
    writeServer('multi', {
      name: 'multi',
      description: 'two transports',
      packages: [HTTP_SERVER.packages[0], STDIO_SERVER.packages[0]],
    });
    const def = new McpRegistry(registryPath).get('multi')!;
    assert.equal(pickPackage(def)?.transportType, 'stdio');
  });

  it('requiredSecrets returns only the secret-flagged inputs', () => {
    writeServer('jira-mcp', STDIO_SERVER);
    const pkg = new McpRegistry(registryPath).get('jira-mcp')!.packages[0];
    const secrets = requiredSecrets(pkg);
    assert.equal(secrets.length, 1);
    assert.equal(secrets[0].name, 'JIRA_TOKEN');
  });
});
