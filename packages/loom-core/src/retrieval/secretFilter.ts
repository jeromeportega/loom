import { minimatch } from 'minimatch';

// Re-export the existing redact helper so story-057-003's searchBounded
// and any future caller have a single import path for both exclusion and redaction.
export { redactSecrets } from '../util/redact.js';

/**
 * Return true when relPath matches any secret glob (before reading the file).
 * Uses { dot: true } so dotfiles like .env are matched by ** patterns.
 */
export function isSecretPath(relPath: string, secretGlobs: string[]): boolean {
  return secretGlobs.some(g => minimatch(relPath, g, { dot: true }));
}
