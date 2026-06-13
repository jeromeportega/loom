import type { LessonRow } from './lesson.js';

/**
 * Splits text into a lowercase token set. Splits on any non-alphanumeric
 * character (spaces, hyphens, punctuation) and drops single-character tokens.
 * Pure and deterministic — no LLM, no embeddings, no network (ADR-004).
 *
 * Known limitation: synonyms are not matched (e.g. a 'migrations' lesson will
 * not match a 'schema upgrade' story). This is accepted at v4.0; the seam is
 * isolated so a semantic ranker can replace it later.
 */
export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

/**
 * Select the most relevant lessons for a story using keyword overlap only.
 * Match is defined as non-empty token overlap between
 * `tokenize(category + ' ' + general_rule)` and
 * `tokenize(story.title + ' ' + description + ' ' + epicTitle)`.
 * Results are ranked by overlap count (descending), then by id (ascending)
 * for determinism on ties. Returns at most `topK` (default 3) lessons.
 */
export function selectLessonsForStory(
  story: { id: string; title: string; description: string },
  epicTitle: string,
  lessons: LessonRow[],
  opts?: { topK?: number },
): LessonRow[] {
  const topK = opts?.topK ?? 3;
  const storyTokens = tokenize(
    `${story.title} ${story.description} ${epicTitle}`,
  );

  if (storyTokens.size === 0) return [];

  const scored = lessons
    .map((lesson) => {
      const lessonTokens = tokenize(
        `${lesson.category} ${lesson.general_rule}`,
      );
      let overlap = 0;
      for (const token of lessonTokens) {
        if (storyTokens.has(token)) overlap++;
      }
      return { lesson, overlap };
    })
    .filter(({ overlap }) => overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.lesson.id - b.lesson.id);

  return scored.slice(0, topK).map(({ lesson }) => lesson);
}
