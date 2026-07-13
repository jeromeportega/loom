import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export type PersonaId = 'analyst' | 'pm' | 'architect' | 'researcher' | 'qa';

export interface Persona {
  id: string;
  name: string;
  title: string;
  icon: string;
  role: string;
  handsOffTo: string | null;
  /** Markdown body: persona description + headless task instructions. */
  body: string;
  /** Full system prompt to pass to the LLM (persona-stable, safe to cache). */
  systemPrompt: string;
}

/**
 * Loads bundled loom planning personas (analyst, pm, architect) from the
 * package's `personas/` directory. These are loom's own persona definitions —
 * Mary (Analyst), John (PM), Winston (Architect) — tuned for headless operation.
 */
export class PersonaLoader {
  /** Resolves the `personas/` directory, which ships at the package root. */
  static personaDir(): string {
    // At runtime __dirname is <pkg>/dist/planner. personas/ is at <pkg>/personas.
    const candidates = [
      path.resolve(__dirname, '../../personas'),
      path.resolve(__dirname, '../personas'),
      path.resolve(process.cwd(), 'packages/loom-core/personas'),
    ];
    for (const dir of candidates) {
      if (fs.existsSync(dir)) return dir;
    }
    throw new Error(
      `loom personas directory not found. Looked in:\n  ${candidates.join('\n  ')}`
    );
  }

  /** The planning-pipeline personas, in sequence. ('researcher' and 'qa' are
   *  loadable via load() but are not part of the Analyst→PM→Architect plan flow;
   *  'qa' runs only when QA_PLANNING is enabled.) */
  static available(): PersonaId[] {
    return ['analyst', 'pm', 'architect'];
  }

  static load(id: PersonaId): Persona {
    const file = path.join(PersonaLoader.personaDir(), `${id}.md`);
    if (!fs.existsSync(file)) {
      throw new Error(`Persona file not found: ${file}`);
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;

    const required = ['id', 'name', 'title', 'icon', 'role'];
    for (const key of required) {
      if (typeof fm[key] !== 'string' || (fm[key] as string).length === 0) {
        throw new Error(`Persona "${id}" is missing required frontmatter: ${key}`);
      }
    }

    const body = parsed.content.trim();
    const persona: Persona = {
      id: fm.id as string,
      name: fm.name as string,
      title: fm.title as string,
      icon: fm.icon as string,
      role: fm.role as string,
      handsOffTo:
        typeof fm.hands_off_to === 'string' ? (fm.hands_off_to as string) : null,
      body,
      systemPrompt: buildSystemPrompt(fm, body),
    };
    return persona;
  }
}

/**
 * Reads a bundled prompt file (`personas/<name>.md`) verbatim. Used for prompt
 * templates that are not persona definitions — e.g. `skill-extractor`.
 */
export function loadBundledPrompt(name: string): string {
  const file = path.join(PersonaLoader.personaDir(), `${name}.md`);
  if (!fs.existsSync(file)) {
    throw new Error(`Bundled prompt not found: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function buildSystemPrompt(fm: Record<string, unknown>, body: string): string {
  return [
    `You are ${fm.name as string}, a ${fm.title as string}, operating as a loom agent.`,
    `Your role: ${fm.role as string}`,
    '',
    'Fully adopt the persona and follow the headless task instructions below exactly.',
    '',
    body,
  ].join('\n');
}
