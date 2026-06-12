import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { openDatabase } from '@loom-ai/core';
import { createApp, newToken } from '@loom-ai/web';

export interface WebOptions {
  /** Port to bind. Default: 8765, with a small free-port search if taken. */
  port?: number;
  /** Don't auto-open the browser. */
  noOpen?: boolean;
}

/**
 * `loom web` — launches the loom dashboard server, prints the URL with
 * a per-launch random token, and opens the browser. Binds 127.0.0.1 only;
 * the token defends against rogue same-machine processes.
 */
export async function runWeb(opts: WebOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }
  const db = openDatabase(loomDir);
  const token = newToken();
  const staticDir = resolveStaticDir();
  const loomBin = resolveLoomBin();

  const app = createApp({ db, token, staticDir, projectRoot, loomBin });
  const startPort = opts.port ?? 8765;
  const port = await listen(app, startPort);
  const url = `http://127.0.0.1:${port}/#token=${token}`;

  console.log('');
  console.log(`  🌐 loom web — http://127.0.0.1:${port}/`);
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
