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
      process.exit(1);
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
        process.exit(1);
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

    if (!opts._refiner) {
      console.log('\n  Proposing next epic — ranking lessons + opportunities…\n');
    }

    let result;
    try {
      result = await proposeNextEpic({
        lessonStore,
        opportunityStore,
        refiner,
        planner,
        epicStore,
        audit,
        minBriefQualityScore,
      });
    } catch (err) {
      console.error('\n  Proposal failed:', (err as Error).message);
      process.exit(1);
      return;
    }

    if (result.ok) {
      console.log(`  Proposed epic: ${result.epicId}`);
      console.log('');
      console.log('  Review the plan, then:');
      console.log(`    loom approve ${result.epicId}  approve the proposed epic`);
      console.log(`    loom reject  ${result.epicId}  reject it`);
      console.log('');
    } else {
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
      process.exit(1);
    }
  } finally {
    if (ownDb && db) db.close();
  }
}
