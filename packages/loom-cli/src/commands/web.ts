import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp, newToken } from '@loom-ai/web';
import { ProjectRegistry, defaultMachineConfigPath } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

export interface WebOptions {
  /** Port to bind. Default: 8765, with a small free-port search if taken. */
  port?: number;
  /** Don't auto-open the browser. */
  noOpen?: boolean;
  /**
   * Serve GET routes without authentication; mutations still require the write
   * token. Also enabled by LOOM_WEB_READONLY=1 environment variable.
   */
  readOnly?: boolean;
}

/**
 * Reads `project_root` from the machine-level config JSON, if present.
 * Returns null when the file is absent, unreadable, or has no valid entry.
 */
function readMachineConfigProjectRoot(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const root = parsed.project_root;
    if (typeof root === 'string' && root.length > 0) return root;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves which loom project root to serve.
 *
 * Resolution order (first match wins):
 *   1. CWD has `.loom/policy.yaml` → serve CWD.
 *   2. ProjectRegistry has at least one entry → serve the first registered project.
 *   3. Machine config has `project_root` pointing to an initialized repo → serve it.
 *   4. Throw with a clear message.
 *
 * Optional parameters are for dependency injection in tests.
 */
export function resolveWebRoot(
  cwd: string,
  registry?: ProjectRegistry,
  machineConfigPath?: string
): { projectRoot: string; loomDir: string } {
  const cwdLoomDir = path.join(cwd, '.loom');
  if (fs.existsSync(path.join(cwdLoomDir, 'policy.yaml'))) {
    return { projectRoot: cwd, loomDir: cwdLoomDir };
  }

  const reg = registry ?? new ProjectRegistry();
  const projects = reg.list();
  if (projects.length > 0) {
    const projectRoot = projects[0].root;
    return { projectRoot, loomDir: path.join(projectRoot, '.loom') };
  }

  const cfgPath = machineConfigPath ?? defaultMachineConfigPath();
  const machineRoot = readMachineConfigProjectRoot(cfgPath);
  if (machineRoot) {
    const machineRootLoomDir = path.join(machineRoot, '.loom');
    if (fs.existsSync(path.join(machineRootLoomDir, 'policy.yaml'))) {
      return { projectRoot: machineRoot, loomDir: machineRootLoomDir };
    }
  }

  throw new Error(
    'loom is not initialized in this directory and no loom project is registered. Run `loom init` first.'
  );
}

/**
 * `loom web` — launches the loom dashboard server, prints the URL with
 * a per-launch random token, and opens the browser. Binds 127.0.0.1 only;
 * the token defends against rogue same-machine processes.
 */
export async function runWeb(opts: WebOptions = {}): Promise<void> {
  let projectRoot: string;
  let loomDir: string;
  try {
    ({ projectRoot, loomDir } = resolveWebRoot(process.cwd()));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const db = openProjectDatabase(projectRoot);
  const token = newToken();
  const staticDir = resolveStaticDir();
  const loomBin = resolveLoomBin();
  const readOnly = opts.readOnly ?? process.env.LOOM_WEB_READONLY === '1';

  const app = createApp({ db, token, staticDir, projectRoot, loomBin, readOnly });
  const startPort = opts.port ?? 8765;
  const port = await listen(app, startPort);
  const url = `http://127.0.0.1:${port}/#token=${token}`;

  console.log('');
  console.log(`  🌐 loom web — http://127.0.0.1:${port}/`);
  if (readOnly) {
    console.log('  Read-only mode: GET routes are public; mutations require the write token.');
  }
  console.log(`  Token (also embedded in the URL fragment below):`);
  console.log(`    ${token}`);
  console.log('');
  console.log(`  Open: ${url}`);
  console.log('');
  console.log('  Ctrl-C to stop.');
  console.log('');

  if (!opts.noOpen) {
    openInBrowser(url);
  }
}

/**
 * Resolves how to spawn the loom CLI from the web server's approve handler.
 * Returns the command + leading-args tuple to prepend; the web server tacks
 * `['run', '<epic-id>']` onto the end.
 *
 * Two cases:
 *   - Globally installed: `loom` on PATH → ['loom'].
 *   - In-monorepo dev: this file lives under packages/loom-cli/dist/commands/,
 *     so we can spawn the current Node binary against ../index.js → no
 *     dependency on `npm link` having been run.
 */
function resolveLoomBin(): string[] {
  const local = path.resolve(__dirname, '..', 'index.js');
  if (fs.existsSync(local)) {
    return [process.execPath, local];
  }
  return ['loom'];
}

/**
 * Finds the directory of the built React bundle, if it exists.
 * Resolved relative to the @loom-ai/web package's dist dir, with
 * fallbacks for in-monorepo / installed-globally layouts.
 */
function resolveStaticDir(): string | undefined {
  const candidates = [
    // Installed: @loom-ai/web/dist/public
    path.resolve(require.resolve('@loom-ai/web/package.json'), '..', 'dist', 'public'),
    // In-monorepo dev: ../loom-web/dist/public
    path.resolve(__dirname, '..', '..', '..', 'loom-web', 'dist', 'public'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Binds the Express app to the first free port starting at `startPort`,
 * up to startPort+20. Resolves with the chosen port.
 */
function listen(app: ReturnType<typeof createApp>, startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryBind = (): void => {
      const server = http.createServer(app);
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && port < startPort + 20) {
          port += 1;
          tryBind();
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    tryBind();
  });
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' :
    process.platform === 'win32' ? 'cmd' :
    'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Best-effort; the URL is printed regardless.
  }
}

export const spec: CommandDescription = {
  name: 'web',
  summary: 'Launch the loom web dashboard (localhost-only)',
  whenToUse: 'Use to open the local observability dashboard in a browser. Starts an Express server with a random auth token; the URL is printed on startup.',
  arguments: [],
  options: [
    { name: '--port', type: 'number', description: 'Port to bind (default: 8765, with free-port search if taken)', changesOutputShape: false },
    { name: '--no-open', type: 'boolean', description: "Don't auto-open the browser after starting", changesOutputShape: false },
    { name: '--read-only', type: 'boolean', description: 'Serve GET routes without authentication; mutations still require the write token', changesOutputShape: false },
  ],
  output: { text: 'Dashboard URL with auth token printed to stdout' },
  examples: [
    { command: 'loom web', description: 'Launch the dashboard and open it in the browser' },
    { command: 'loom web --port 9000', description: 'Launch on port 9000' },
    { command: 'loom web --no-open --read-only', description: 'Launch without opening a browser, in read-only mode' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Dashboard started successfully' },
    { code: 1, meaning: 'Port binding failed or loom not initialized' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Port already in use'],
  relationships: { prerequisites: ['init'], nextSteps: [] },
};
