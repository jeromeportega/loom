import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import type { LLMClient } from '../llm/index.js';
import { createDatabase } from '../state/index.js';
import { Planner, validateEpicSet, epicNumber } from '../planner/index.js';
import { EpicYamlSchema, type EpicYaml } from '../types.js';
import type { EvalCase, EvalCheck, EvalCaseResult, EvalReport } from './types.js';

export interface EvalRunnerOptions {
  llm: LLMClient;
  model: string;
}

/**
 * Runs planning eval cases and grades the outcomes. Each case runs the full
 * planner in an isolated temp directory with its own database, so an eval run
 * never touches the user's real state. Runnable with a MockLLMClient (CI — the
 * harness check) or a real backend (an actual quality measurement).
 */
export class EvalRunner {
  constructor(private opts: EvalRunnerOptions) {}

  async run(suite: string, cases: EvalCase[]): Promise<EvalReport> {
    const results: EvalCaseResult[] = [];
    for (const evalCase of cases) {
      results.push(await this.runCase(evalCase));
    }
    const passed = results.filter((r) => r.passed).length;
    return {
      suite,
      total: results.length,
      passed,
      score: results.length > 0 ? passed / results.length : 0,
      cases: results,
    };
  }

  private async runCase(evalCase: EvalCase): Promise<EvalCaseResult> {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-eval-'));
    try {
      const db = createDatabase(path.join(tmpRoot, '.loom', 'loom.db'));
      const planner = new Planner({
        projectRoot: tmpRoot,
        llm: this.opts.llm,
        model: this.opts.model,
        db,
      });

      let epics: EpicYaml[];
      try {
        const result = await planner.run(evalCase.brief);
        epics = result.epicPaths.map((p) =>
          EpicYamlSchema.parse(yaml.load(fs.readFileSync(p, 'utf8')))
        );
      } catch (err) {
        return {
          caseId: evalCase.id,
          passed: false,
          error: (err as Error).message,
          checks: [],
        };
      }

      const checks = evaluateChecks(evalCase, epics);
      return {
        caseId: evalCase.id,
        passed: checks.every((c) => c.passed),
        checks,
      };
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

/** Grades a planner's output for one case against its expectations. */
export function evaluateChecks(evalCase: EvalCase, epics: EpicYaml[]): EvalCheck[] {
  const checks: EvalCheck[] = [];
  const expect = evalCase.expect;
  const epicCount = epics.length;
  const storyCount = epics.reduce((n, e) => n + e.stories.length, 0);

  if (expect.minEpics !== undefined) {
    checks.push(bound('epics >= min', epicCount >= expect.minEpics, `${epicCount} epics`));
  }
  if (expect.maxEpics !== undefined) {
    checks.push(bound('epics <= max', epicCount <= expect.maxEpics, `${epicCount} epics`));
  }
  if (expect.minStories !== undefined) {
    checks.push(bound('stories >= min', storyCount >= expect.minStories, `${storyCount} stories`));
  }
  if (expect.maxStories !== undefined) {
    checks.push(bound('stories <= max', storyCount <= expect.maxStories, `${storyCount} stories`));
  }
  if (expect.dependenciesValid) {
    const startNum = epics.length > 0 ? epicNumber(epics[0].epic_id) : 1;
    const err = validateEpicSet(epics, startNum);
    checks.push({
      name: 'dependencies_valid',
      passed: err === null,
      detail: err ?? 'epic/story dependencies are sound',
    });
  }
  return checks;
}

function bound(name: string, passed: boolean, detail: string): EvalCheck {
  return { name, passed, detail };
}
