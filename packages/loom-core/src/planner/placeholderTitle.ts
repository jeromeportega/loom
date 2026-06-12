/**
 * Derives a human-meaningful placeholder title for a reserved epic row from
 * the raw brief, BEFORE the planner has produced its real title. The reserved
 * row is durable the instant submission happens (synchronous better-sqlite3
 * insert) so `loom status` / `loom web` can answer "what kicked off this job?"
 * before the ~5-minute Analyst → PM → Architect chain finishes; the planner's
 * real title later replaces this through the existing completion seam.
 *
 * Rule: the brief's first Markdown heading (`# … ` through `###### … `) when
 * present, otherwise the first 60 characters of the brief. Never throws — a
 * short or empty brief simply yields its (possibly short) slice.
 */
export function derivePlaceholderTitle(brief: string): string {
  const heading = brief.match(/^#{1,6}\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return brief.slice(0, 60);
}
