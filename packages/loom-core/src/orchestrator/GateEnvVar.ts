import type { EnvVarFinding } from './FinalizeGates.js';

// Matches process.env.UPPER_SNAKE_CASE — uppercase letters, digits, underscore.
// Lowercase-only names (e.g. process.env.foo) do not match [A-Z][A-Z0-9_]*.
const ENV_VAR_RE = /process\.env\.([A-Z][A-Z0-9_]*)/g;

// Ambient system / runtime / CI variables that are supplied by the OS, the
// shell, the test runner, or the CI provider — never something an operator
// would document in .env.example. Flagging these is pure noise (the original
// gate flagged process.env.PATH). npm lifecycle variables (npm_package_*,
// npm_config_*) are lowercase-prefixed and so never match ENV_VAR_RE's leading
// [A-Z] in the first place — no explicit guard is needed for them.
const AMBIENT_ENV_VARS = new Set([
  'NODE_ENV', 'CI', 'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'SHLVL',
  'TERM', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP',
  'TEMP', 'TZ', 'HOSTNAME', 'DEBUG', 'FORCE_COLOR', 'NO_COLOR', 'COLORTERM',
  'EDITOR', 'PAGER', 'DISPLAY', 'SSH_AUTH_SOCK', 'GITHUB_ACTIONS', 'RUNNER_OS',
]);

// Matches the +++ b/ header line in a unified diff to extract the file path.
const DIFF_FILE_RE = /^\+\+\+ b\/(.+)$/;

/**
 * Pure function. Scans the added lines of `epicDiff` for `process.env.VAR`
 * references and returns one finding per (varName, filePath) pair that is
 * absent from `envExampleVars`.
 *
 * Pass null when .env.example is absent — returns [] without findings.
 * The notice for a missing .env.example is emitted by the runFinalizeGates caller.
 */
export function checkUndocumentedEnvVars(opts: {
  epicDiff: string;
  envExampleVars: Set<string> | null;
}): EnvVarFinding[] {
  if (opts.envExampleVars === null) return [];
  if (!opts.epicDiff.trim()) return [];

  const findings: EnvVarFinding[] = [];
  // Track (varName, filePath) pairs already reported to avoid duplicates.
  const seen = new Set<string>();
  let currentFile = '';

  for (const line of opts.epicDiff.split('\n')) {
    const fileMatch = DIFF_FILE_RE.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }

    // Only scan added lines, not removed or context lines.
    if (!line.startsWith('+') || line.startsWith('+++')) continue;

    ENV_VAR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ENV_VAR_RE.exec(line)) !== null) {
      const varName = match[1];
      if (opts.envExampleVars.has(varName)) continue;
      if (AMBIENT_ENV_VARS.has(varName)) continue;

      const key = `${varName}\0${currentFile}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({ varName, filePath: currentFile, lineSnippet: line });
    }
  }

  return findings;
}
