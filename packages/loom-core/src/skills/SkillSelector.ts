import type { Story } from '../types.js';
import type { SkillManifest } from './SkillStore.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'use', 'using',
  'add', 'adds', 'when', 'where', 'which', 'their', 'has', 'have', 'are', 'was',
  'will', 'should', 'must', 'can', 'returns', 'return', 'story', 'epic',
]);

/**
 * Picks the skills most relevant to a piece of work. V1 scores by keyword/token
 * overlap between the work's text and each skill's name + description. The
 * scoring is intentionally swappable — a future version can drop in embeddings
 * without changing callers.
 */
export class SkillSelector {
  /** Selects skills relevant to a story (worker dispatch). */
  static select(
    story: Story,
    manifests: SkillManifest[],
    limit = 5
  ): SkillManifest[] {
    return SkillSelector.selectByText(
      [story.title, story.description, story.tech_notes ?? ''].join(' '),
      manifests,
      limit
    );
  }

  /** Selects skills relevant to free text — e.g. a planning brief. */
  static selectByText(
    text: string,
    manifests: SkillManifest[],
    limit = 5
  ): SkillManifest[] {
    const tokens = tokenize(text);

    const scored = manifests
      // 'disabled' skills are never injected.
      .filter((m) => m.lifecycle !== 'disabled')
      .map((m) => ({
        manifest: m,
        score: overlap(tokens, tokenize(`${m.name} ${m.description}`)),
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    // Active (and hand-authored) skills are eligible for every slot. Candidates
    // are a canary — they fill only the slots active skills did not take.
    const active = scored
      .filter((s) => s.manifest.lifecycle === 'active')
      .slice(0, limit)
      .map((s) => s.manifest);

    const spare = limit - active.length;
    if (spare <= 0) return active;

    const canary = scored
      .filter((s) => s.manifest.lifecycle === 'candidate')
      .slice(0, spare)
      .map((s) => s.manifest);

    return [...active, ...canary];
  }
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of b) {
    if (a.has(token)) count++;
  }
  return count;
}
