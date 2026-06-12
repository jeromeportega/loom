#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLLMClient, createWorker, openDatabase, AuditLog } from '@loom-ai/core';
import { HANDLERS, TOOL_DEFINITIONS } from './tools/index.js';
import type { ToolContext } from './tools/index.js';

// Read the version from this package's package.json at runtime so the
// MCP handshake reports the actual published version after each release —
// no source bump needed.
const PKG_VERSION = (
  JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
).version;

/** Builds the production tool context: real Anthropic client and Claude worker. */
export function productionContext(projectRoot = process.cwd()): ToolContext {
  const loomDir = path.join(projectRoot, '.loom');
  return {
    projectRoot,
    loomDir,
    createLLM: (backend, opts) => createLLMClient(backend, opts),
    createWorker: (opts) => createWorker(opts),
    background: (label, work) => {
      work.catch((err: unknown) => {
        const msg = (err as Error).message;
        // stderr is safe — stdout is the MCP protocol channel.
        process.stderr.write(`[loom] background task "${label}" failed: ${msg}\n`);
        // Also record it so the failure is visible via loom_get_audit_log.
        try {
          new AuditLog(openDatabase(loomDir)).record({
            action: 'background_failure',
            command: label,
            allowed: false,
            detail: { error: msg },
          });
        } catch {
          // DB unavailable — the stderr line above is the fallback record.
        }
      });
    },
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'loom', version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );
  const ctx = productionContext();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = HANDLERS[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    const result = await handler(ctx, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
