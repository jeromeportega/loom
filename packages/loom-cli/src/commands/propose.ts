import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  openDatabase,
  PolicyEngine,
  createLLMClient,
  modelFor,
  AuditLog,
  EpicStore,
  LessonStore,
  OpportunityStore,
  BriefRefiner,
  Planner,
  proposeNextEpic,
} from '@loom-ai/core';
import type { LLMClient, BriefRefinement } from '@loom-ai/core';

export interface ProposeOptions {
  /** Test seam — inject a stub LLMClient. Production callers omit this. */
  llm?: LLMClient;
  /** Test seam — inject a stub BriefRefiner (bypasses LLM call). */
  _refiner?: { refine(rough: string): Promise<BriefRefinement> };
  /** Test seam — inject a stub Planner (bypasses planning pipeline). */
  _planner?: { run(brief: string): Promise<{ epicIds: string[] }> };
  /** Test seam — inject a pre-opened Database (bypasses openDatabase). */
  _db?: Database.Database;
  /** Test seam — override project root (bypasses process.cwd()). */
  _projectRoot?: string;
  /** Number of top lessons to include (mirrors loom_propose top_lessons). */
  topLessons?: number;
  /** Number of top opportunities to include (mirrors loom_propose top_opps). */
  topOpps?: number;
  /** Emit machine-readable JSON output instead of human text. */
  json?: boolean;
}

/**
 * `loom propose` — proposes a next epic by combining top-ranked lessons
 * with top open opportunities. Exactly one BriefRefiner LLM call per run.
 * EXPLICIT TRIGGER ONLY: no scheduler or auto-approve path.
 */
export async function runPropose(opts: ProposeOptions = {}): Promise<void> {
  const projectRoot = opts._projectRoot ?? process.cwd();
  const loomDir = path.join(projectRoot, '.loom');

  // Guard: test seams must be injected together — an _db without stubs would
  // construct BriefRefiner/Planner with an empty model string.
  if (opts._db && (!opts._refiner || !opts._planner)) {
    throw new Error(
      'ProposeOptions: when _db is provided, _refiner and _planner must also be provided'
    );
  }

  let db: Database.Database | null = null;
  let minBriefQualityScore = 7;
  let model = '';
  let llm = opts.llm ?? null;

  if (opts._db) {
    // Test path: production setup (policy, db, llm) is bypassed via injected seams.
    db = opts._db;
  } else {
    if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
      console.error('loom is not initialized in this directory. Run `loom init` first.');
      process.exitCode = 1;
      return;
    }
    // Single policy load — reused for both DB setup and LLM creation.
    const policy = PolicyEngine.load(loomDir).policyData;
    minBriefQualityScore = policy.agents.min_brief_quality_score;
    model = modelFor(policy, 'planning');
    db = openDatabase(loomDir);

    if (!llm && !opts._refiner) {
      try {
        llm = createLLMClient(policy.agents.llm_backend);
      } catch (err) {
        db.close();
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
    }
  }

  const ownDb = !opts._db; // only close the db we opened ourselves
  try {
    const lessonStore = new LessonStore(db);
    const opportunityStore = new OpportunityStore(db);
    const epicStore = new EpicStore(db);
    const audit = new AuditLog(db);

    const refiner =
      opts._refiner ??
      new BriefRefiner({ projectRoot, llm: llm!, model });

    const planner =
      opts._planner ??
      new Planner({ projectRoot, llm: llm!, model, db });

    if (!opts._refiner && !opts.json) {
      console.log('\n  Proposing next epic — ranking lessons + opportunities…\n');
    }

    let result;
    try {
      result = await proposeNextEpic(
        {
          lessonStore,
          opportunityStore,
          refiner,
          planner,
          epicStore,
          audit,
          minBriefQualityScore,
        },
        { topLessons: opts.topLessons, topOpps: opts.topOpps }
      );
    } catch (err) {
      console.error('\n  Proposal failed:', (err as Error).message);
      process.exitCode = 1;
      return;
    }

    if (result.ok) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, epicId: result.epicId }));
        return;
      }
      console.log(`  Proposed epic: ${result.epicId}`);
      console.log('');
      console.log('  Review the plan, then:');
      console.log(`    loom approve ${result.epicId}  approve the proposed epic`);
      console.log(`    loom reject  ${result.epicId}  reject it`);
      console.log('');
    } else {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, critique: result.critique }));
        process.exitCode = 1;
        return;
      }
      console.error('  Proposal did not pass the brief quality gate.');
      console.error(`  Score: ${result.critique.quality_score}/10`);
      const c = result.critique.critique;
      const issues = [
        ['Ambiguities', c.ambiguities],
        ['Missing scope', c.missing_scope],
        ['Untestable claims', c.untestable_claims],
      ] as const;
      for (const [label, items] of issues) {
        if (items.length === 0) continue;
        console.error(`\n  ${label}:`);
        for (const item of items) console.error(`    • ${item}`);
      }
      if ((result.critique.questions ?? []).length > 0) {
        console.error('\n  Questions:');
        for (const q of result.critique.questions ?? []) {
          console.error(`    • ${q}`);
        }
      }
      process.exitCode = 1;
      return;
    }
  } finally {
    if (ownDb && db) db.close();
  }
}

export const spec: CommandDescription = {
  name: 'propose',
  summary: 'Propose the next epic from top lessons and opportunities',
  whenToUse: 'Use when you want loom to suggest what to build next based on accumulated lessons and open opportunities. Exactly one LLM call; outputs a brief that feeds `loom epic`.',
  arguments: [],
  options: [
    { name: '--top-lessons', type: 'number', description: 'Number of top lessons to include in the proposal (default: all)', changesOutputShape: false },
    { name: '--top-opps', type: 'number', description: 'Number of top opportunities to include in the proposal (default: all)', changesOutputShape: false },
    { name: '--json', type: 'boolean', description: 'Emit machine-readable JSON: { ok, epicId? } or { ok, critique }', changesOutputShape: true },
  ],
  output: {
    text: 'Proposed epic id and next steps, or critique if the proposal failed the quality gate',
    json: { supported: true, shape: '{ ok: boolean, epicId?: string, critique?: object }' },
  },
  examples: [
    { command: 'loom propose', description: 'Let loom propose the next epic from lessons and opportunities' },
    { command: 'loom propose --top-lessons 5 --top-opps 3', description: 'Limit to top 5 lessons and 3 opportunities' },
    { command: 'loom propose --json', description: 'Emit the proposal result as JSON' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Proposal created and passed the quality gate' },
    { code: 1, meaning: 'Proposal failed the quality gate or LLM error' },
  ],
  errors: ['loom is not initialized — run `loom init` first', 'Proposal failed the brief quality gate', 'ANTHROPIC_API_KEY not set'],
  relationships: { prerequisites: ['init', 'scan'], nextSteps: ['epic', 'approve'] },
};
