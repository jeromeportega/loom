import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createApp, newToken } from '@loom-ai/web';
import type { CreateAppOptions } from '@loom-ai/web';
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
 *   4. Return null — the server starts with no current project.
 *
 * Never throws; never calls process.exit. Returns null when no project resolves.
 * Optional parameters are for dependency injection in tests.
 */
export function resolveWebRoot(
  cwd: string,
  registry?: ProjectRegistry,
  machineConfigPath?: string
): { projectRoot: string; loomDir: string } | null {
  const cwdLoomDir = path.join(cwd, '.loom');
  if (fs.existsSync(path.join(cwdLoomDir, 'policy.yaml'))) {
    return { projectRoot: cwd, loomDir: cwdLoomDir };
  }

  const reg = registry ?? new ProjectRegistry();
  // Pick the first REGISTERED project that is still initialized. A registered
  // root whose `.loom/` was removed (or whose directory was recreated) would
  // otherwise be served with a freshly-minted empty DB — a silently blank
  // dashboard. Skip such entries and fall through to machine config / null.
  for (const project of reg.list()) {
    const projLoomDir = path.join(project.root, '.loom');
    if (fs.existsSync(path.join(projLoomDir, 'policy.yaml'))) {
      return { projectRoot: project.root, loomDir: projLoomDir };
    }
  }

  const cfgPath = machineConfigPath ?? defaultMachineConfigPath();
  const machineRoot = readMachineConfigProjectRoot(cfgPath);
  if (machineRoot) {
    const machineRootLoomDir = path.join(machineRoot, '.loom');
    if (fs.existsSync(path.join(machineRootLoomDir, 'policy.yaml'))) {
      return { projectRoot: machineRoot, loomDir: machineRootLoomDir };
    }
  }

  return null;
}

/** Dependency-injection seams used only in unit tests. */
interface RunWebInternals {
  _resolveWebRoot?: typeof resolveWebRoot;
  _createApp?: (opts: CreateAppOptions) => ReturnType<typeof createApp>;
  _listen?: (app: ReturnType<typeof createApp>, startPort: number) => Promise<number>;
}

/**
 * `loom web` — launches the loom dashboard server, prints the URL with
 * a per-launch random token, and opens the browser. Binds 127.0.0.1 only;
 * the token defends against rogue same-machine processes.
 *
 * When no loom project resolves (uninitialized directory, empty registry,
 * no machine config), the server still starts with `currentProject = null`.
 */
export async function runWeb(opts: WebOptions = {}, _internals: RunWebInternals = {}): Promise<void> {
  const resolverFn = _internals._resolveWebRoot ?? resolveWebRoot;
  // Pass undefined for registry so resolveWebRoot uses its own internal default,
  // matching the pre-refactor call site and avoiding a wasted allocation in tests.
  const resolved = resolverFn(process.cwd(), undefined, defaultMachineConfigPath());
  const projectRoot = resolved?.projectRoot ?? null;

  const db = projectRoot !== null ? openProjectDatabase(projectRoot) : null;
  const token = newToken();
  const staticDir = resolveStaticDir();
  const loomBin = resolveLoomBin();
  const readOnly = opts.readOnly ?? process.env.LOOM_WEB_READONLY === '1';

  const createAppFn = _internals._createApp ?? createApp;
  const app = createAppFn({ db, token, staticDir, projectRoot, loomBin, readOnly });
  const listenFn = _internals._listen ?? listen;
  const startPort = opts.port ?? 8765;
  const port = await listenFn(app, startPort);
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
    // Installed: @loom-ai/web/client-dist (the Vite SPA build; in package `files`)
    path.resolve(require.resolve('@loom-ai/web/package.json'), '..', 'client-dist'),
    // In-monorepo dev: ../loom-web/client-dist
    path.resolve(__dirname, '..', '..', '..', 'loom-web', 'client-dist'),
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
    { code: 0, meaning: 'Dashboard started successfully (with or without a current project)' },
    { code: 1, meaning: 'Port binding failed' },
  ],
  errors: ['Port already in use'],
  relationships: { prerequisites: ['init'], nextSteps: [] },
};
