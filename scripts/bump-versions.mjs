#!/usr/bin/env node
/**
 * Bump every workspace's package.json `version` to the given semver, and
 * update cross-workspace dep ranges to match (e.g. `"@loom-ai/core":
 * "^0.1.0"` → `"^0.2.0"`).
 *
 * Usage:
 *   node scripts/bump-versions.mjs <version>
 *   node scripts/bump-versions.mjs 0.3.0
 *   node scripts/bump-versions.mjs v0.3.0   # leading "v" stripped
 *
 * Called from .github/workflows/publish-npm.yml so the release workflow
 * can't drift from the tag again — the workflow header used to prescribe
 * this script, but the script never existed; that's how v0.2.0 blew up the
 * first time. Also runnable locally when cutting a release by hand:
 * `node scripts/bump-versions.mjs 0.3.0 && npm install`.
 *
 * Idempotent: if every workspace already matches the target, exits 0 with
 * "All N workspaces already at X" and no files are touched.
 *
 * Does surgical text edits (not JSON.parse + JSON.stringify) so the
 * existing formatting of each package.json — compact arrays, single-line
 * objects — is preserved. The version field at root indent and each
 * cross-workspace dep range are the only bytes that change.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/bump-versions.mjs <version>');
  process.exit(1);
}

const target = raw.startsWith('v') ? raw.slice(1) : raw;
if (!SEMVER_RE.test(target)) {
  console.error(`Not valid semver: "${raw}"`);
  process.exit(1);
}

// Discover workspaces by walking the root package.json's `workspaces`
// globs directly. Deliberately avoids `npm query .workspace`, which
// returns an empty list until `npm install` has run — that was the
// v0.2.1 incident, where the script ran before install, walked an
// empty list, and silently no-op'd against the release tag.
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const workspaces = discoverWorkspaces(repoRoot, rootPkg.workspaces ?? []);
const wsNames = new Set(workspaces.map((w) => w.name));

/**
 * Walk every glob pattern from the root package.json `workspaces` field
 * and return `{ name, path }` for each directory containing a
 * package.json. Supports the common forms used here (`packages/*`); a
 * trailing `/*` expands to every immediate subdirectory.
 */
function discoverWorkspaces(root, patterns) {
  const found = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const baseDir = join(root, pattern.slice(0, -2));
      if (!existsSync(baseDir)) continue;
      for (const entry of readdirSync(baseDir)) {
        const wsPath = join(baseDir, entry);
        if (!statSync(wsPath).isDirectory()) continue;
        const pkgPath = join(wsPath, 'package.json');
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        found.push({ name: pkg.name, path: wsPath });
      }
    } else {
      const wsPath = join(root, pattern);
      const pkgPath = join(wsPath, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      found.push({ name: pkg.name, path: wsPath });
    }
  }
  if (found.length === 0) {
    console.error('No workspaces found — check root package.json `workspaces` field.');
    process.exit(1);
  }
  return found;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Replace only the root-level `"version": "..."` field, matched at the
 * package.json root-object indent (2 spaces). Nested `"version"` keys
 * (e.g. inside an `exports` map) sit at deeper indent and are not touched.
 */
function replaceVersion(text, value) {
  return text.replace(/^(  "version":\s*)"[^"]*"/m, `$1"${value}"`);
}

/** Replace `"<depName>": "<range>"` everywhere it appears in the file. */
function replaceDep(text, depName, value) {
  const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`("${escaped}":\\s*)"[^"]*"`, 'g'), `$1"${value}"`);
}

let changed = 0;

for (const ws of workspaces) {
  const pkgPath = `${ws.path}/package.json`;
  const original = readFileSync(pkgPath, 'utf8');
  // Parse to know what currently lives in the file; edit the raw text so
  // the formatting (compact arrays, inline objects) is preserved.
  const pkg = JSON.parse(original);
  let next = original;

  if (pkg.version !== target) {
    next = replaceVersion(next, target);
  }

  for (const key of DEP_FIELDS) {
    const deps = pkg[key];
    if (!deps) continue;
    for (const depName of Object.keys(deps)) {
      if (!wsNames.has(depName)) continue;
      const want = `^${target}`;
      if (deps[depName] !== want) {
        next = replaceDep(next, depName, want);
      }
    }
  }

  if (next !== original) {
    writeFileSync(pkgPath, next);
    console.log(`  bumped ${ws.name} → ${target}`);
    changed++;
  }
}

if (changed === 0) {
  console.log(`All ${workspaces.length} workspaces already at ${target}; no files written.`);
} else {
  console.log(`Updated ${changed} of ${workspaces.length} workspace(s) to ${target}.`);
  console.log('Run `npm install` to refresh package-lock.json.');
}
