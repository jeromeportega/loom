import { statSync } from 'node:fs';
import path from 'node:path';
import type { LLMClient, SystemBlock } from '../llm/index.js';
import type { FactCheckResult } from './types.js';

// Matches "path/to/file.ext:N" where N >= 1 (line-zero citations are rejected).
// Requires a word separator or start-of-string before the path.
// NOTE: URL paths (e.g. github.com/org/repo/foo.ts:99) CAN match this regex when
// preceded by a space; they are rejected downstream by the containment + isFile checks.
// Groups: match[1] = file path, match[2] = line number.
const CITATION_REGEX =
  /(?:^|[\s("'`])([\w./\-]+\.(?:ts|tsx|js|jsx|md|yaml|json)):([1-9]\d*)/;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Static portion of the system prompt — eligible for prompt caching.
// repoRoot is injected as a separate, uncached block so the static text is
// actually shared across invocations (a runtime path would break cache keys).
const STATIC_SYSTEM_BLOCK: SystemBlock = {
  text:
    'You are a fact-checker for a software repository. ' +
    'Answer questions by reading repository files with your tools. If you find ' +
    'the answer in a specific file and line, cite it as "path/to/file.ts:lineNumber". ' +
    'Be precise and ground every claim in what you actually read.',
  cache: true,
};

function buildSystemPrompt(repoRoot: string): SystemBlock[] {
  return [
    STATIC_SYSTEM_BLOCK,
    { text: `Repository root: ${repoRoot}` },
  ];
}

export async function factCheck(
  question: string,
  repoRoot: string,
  llm: LLMClient,
  model: string
): Promise<FactCheckResult> {
  try {
    // Omit `nonAgentic` intentionally: LLMRequest has no `tools` field.
    // Agentic mode (tools ENABLED) is the default; passing `nonAgentic` would
    // disable tools (ClaudeCliClient appends --tools-disable), preventing the
    // model from reading repo files and forcing hallucinated citations.
    const response = await llm.complete({
      model,
      system: buildSystemPrompt(repoRoot),
      messages: [{ role: 'user', content: question }],
    });

    const answer = response.text;
    const match = CITATION_REGEX.exec(answer);

    if (match !== null) {
      const filePath = match[1];
      const abs = path.resolve(repoRoot, filePath);
      const root = path.resolve(repoRoot);
      // Containment check: reject path traversal and absolute-path injections.
      // isFile() also rejects directories that happen to share a .ts-looking name.
      if (abs.startsWith(root + path.sep) && isFile(abs)) {
        const canonicalRelPath = path.relative(root, abs);
        return { tag: 'fact-cited', citation: `${canonicalRelPath}:${match[2]}`, answer };
      }
    }
    return { tag: 'fact-uncited', answer };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { tag: 'fact-uncited', answer: message };
  }
}
