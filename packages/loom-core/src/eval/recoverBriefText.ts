import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export type RecoverBriefResult =
  | { ok: true; text: string; source: string }
  | { ok: false; reason: string };

/**
 * Recover the brief text for an epic from the repo tree.
 *
 * Resolution order (ADR-003):
 * 1. .loom/planning/<epicId>/project-brief.md
 * 2. epics/<epicId>.yaml → title + description fields
 *
 * Returns {ok:false} when neither path yields text; the caller MUST
 * exclude that epic from the fixture rather than fabricating a brief.
 *
 * @param epicId  The epic identifier, e.g. 'epic-007'
 * @param root    Repo root; defaults to process.cwd()
 */
export function recoverBriefText(
  epicId: string,
  root: string = process.cwd(),
): RecoverBriefResult {
  // Resolution 1: .loom/planning/<epicId>/project-brief.md
  const briefPath = path.join(root, '.loom', 'planning', epicId, 'project-brief.md');
  if (fs.existsSync(briefPath)) {
    const text = fs.readFileSync(briefPath, 'utf8').trim();
    if (text.length > 0) {
      return { ok: true, text, source: normalisePath(root, briefPath) };
    }
  }

  // Resolution 2: epics/<epicId>.yaml — title + description fallback
  const yamlPath = path.join(root, 'epics', `${epicId}.yaml`);
  if (fs.existsSync(yamlPath)) {
    const yamlContent = fs.readFileSync(yamlPath, 'utf8');

    let title: string | undefined;
    let description: string | undefined;

    try {
      const raw = yaml.load(yamlContent) as Record<string, unknown>;
      if (raw && typeof raw === 'object') {
        title = typeof raw.title === 'string' ? raw.title : undefined;
        description = typeof raw.description === 'string' ? raw.description : undefined;
      }
    } catch {
      // Malformed YAML — fall through to regex extraction of the title line
    }

    if (!title) {
      // Regex extracts the first `title:` line even from otherwise malformed files
      const m = yamlContent.match(/^title:\s+"?(.+?)"?\s*$/m);
      if (m) title = m[1].trim();
    }

    if (title) {
      const text = description ? `${title}\n\n${description}` : title;
      return { ok: true, text: text.trim(), source: normalisePath(root, yamlPath) };
    }
  }

  return {
    ok: false,
    reason:
      `No brief found for ${epicId}: ` +
      `checked .loom/planning/${epicId}/project-brief.md and epics/${epicId}.yaml`,
  };
}

function normalisePath(root: string, absolute: string): string {
  const rel = path.relative(root, absolute);
  // Always forward slashes for cross-platform fixture consistency
  return rel.split(path.sep).join('/');
}
