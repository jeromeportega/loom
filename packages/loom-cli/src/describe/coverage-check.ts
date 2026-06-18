import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import {
  operatorCommands,
  operatorKnobs,
  repoRoot,
  type CoverageReport,
  type SurfaceDiff,
  type Token,
} from './coverage.js';

// Hard contract with docs/capabilities.md (story-015-003 authors the fences to these exact strings).
const FENCE = {
  command: {
    start: '<!-- coverage:command:start -->',
    end: '<!-- coverage:command:end -->',
  },
  knob: {
    start: '<!-- coverage:knob:start -->',
    end: '<!-- coverage:knob:end -->',
  },
} as const;

/**
 * Exact code-span tokens documented inside the named fenced region of a markdown page.
 *
 * Command region: captures `loom <name>` spans → Token = "<name>" (no "loom " prefix).
 * Knob region:    captures `policy.<path>` spans → Token = "<path>" (no "policy." prefix).
 *
 * Returns an empty Set when the region fence is absent — absence is NOT treated as
 * "all covered"; callers see every live token as missing (fails loud).
 */
export function parseDocumentedTokens(markdown: string, kind: 'command' | 'knob'): Set<Token> {
  const { start: startMarker, end: endMarker } = FENCE[kind];
  const startIdx = markdown.indexOf(startMarker);
  const endIdx = markdown.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return new Set();
  }

  const region = markdown.slice(startIdx + startMarker.length, endIdx);
  // Create a fresh regex per call — avoids shared-lastIndex state with the /g flag.
  const re =
    kind === 'command'
      ? /`loom ([^`]+)`/g
      : /`policy\.([^`]+)`/g;

  const tokens = new Set<Token>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(region)) !== null) {
    tokens.add(match[1]);
  }
  return tokens;
}

/**
 * Pure, read-only, import-clean coverage assertion.
 * Compares the live operator surface (commands + knobs) against the documented token
 * regions of docs/capabilities.md, returning a CoverageReport.
 *
 * opts.root overrides the repo root (defaults to walking up from __dirname).
 * opts.program is forwarded to operatorCommands() for live command enumeration.
 */
export function checkCapabilitiesCoverage(opts?: {
  root?: string;
  program?: Command;
}): CoverageReport {
  const root = opts?.root ?? repoRoot();
  const capPath = join(root, 'docs', 'capabilities.md');
  const markdown = readFileSync(capPath, 'utf8');

  const liveCommands = operatorCommands(opts?.program);
  const liveKnobs = operatorKnobs(join(root, 'schemas', 'policy.schema.yaml'));

  const docCommands = parseDocumentedTokens(markdown, 'command');
  const docKnobs = parseDocumentedTokens(markdown, 'knob');

  const commandDiff = makeDiff('command', liveCommands, docCommands);
  const knobDiff = makeDiff('knob', liveKnobs, docKnobs);

  const diffs: SurfaceDiff[] = [commandDiff, knobDiff];
  const ok =
    commandDiff.missing.length === 0 &&
    commandDiff.phantom.length === 0 &&
    knobDiff.missing.length === 0 &&
    knobDiff.phantom.length === 0;

  const messages: string[] = [];
  for (const diff of diffs) {
    if (diff.missing.length > 0) {
      messages.push(
        `[${diff.surface}] live but missing from docs: ${diff.missing.map((t) => JSON.stringify(t)).join(', ')}`
      );
    }
    if (diff.phantom.length > 0) {
      messages.push(
        `[${diff.surface}] documented but absent from live source: ${diff.phantom.map((t) => JSON.stringify(t)).join(', ')}`
      );
    }
  }

  return { ok, diffs, messages };
}

function makeDiff(
  surface: 'command' | 'knob',
  live: Set<Token>,
  documented: Set<Token>
): SurfaceDiff {
  const missing = [...live].filter((t) => !documented.has(t)).sort();
  const phantom = [...documented].filter((t) => !live.has(t)).sort();
  return { surface, missing, phantom };
}
