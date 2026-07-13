import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  SweBenchLoader,
  SweBenchRunner,
  writePredictions,
} from '@loom-ai/core';
import type { SweBenchTask, SweBenchTaskResult } from '@loom-ai/core';

export interface BenchOptions {
  /** Path to the downloaded SWE-bench Lite JSON file. */
  tasks: string;
  /** Max tasks to run. Defaults to 10 to keep smoke runs cheap. */
  limit?: number;
  /** Where to write predictions.json. */
  output?: string;
  /**
   * List tasks and exit without running loom. Useful for sanity-checking
   * the dataset file and the filter shape before paying for real runs.
   */
  dryRun?: boolean;
  /** Force PASSthrough name embedded in predictions.json. */
  modelName?: string;
  /**
   * Policy overrides applied to each per-task `.loom/policy.yaml` after
   * `loom init` and before `loom epic`. Lets the bench operator
   * test interventions (block-and-revise review, skill-gen on/off) without
   * editing the init template.
   */
  reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
  skillGeneration?: 'on' | 'off' | 'sampled';
  /**
   * Override the review model per task — 'cross' routes the reviewer through
   * a different model than the worker via Cursor-CLI (#20). Pair with reviewModelId.
   */
  reviewModel?: 'same' | 'cross';
  reviewModelId?: string;
  /** Override review revise trigger per task. */
  reviewReviseTrigger?: 'blockers' | 'any';
  /**
   * Keep the tempdir of any task that failed (errored or empty patch)
   * for post-mortem inspection. Successful tasks always clean up.
   * Default false — preserve only when debugging.
   */
  preserveFailures?: boolean;
  /**
   * Keep the tempdir of every task, regardless of loom's own pass/fail
   * signal. Catches the loom-passes-but-bench-fails class (eg.
   * django-11019: non-empty patch, but the official harness reports
   * unresolved). Implies preserveFailures.
   */
  preserveAll?: boolean;
}

const DEFAULT_LIMIT = 10;

/**
 * `loom bench swe-bench-lite` — runs loom end-to-end against SWE-bench Lite
 * tasks and emits predictions.json in the format the official SWE-bench
 * harness consumes. Loom does NOT score the patches itself; that is the
 * official harness's job (Docker per repo, env setup, FAIL_TO_PASS /
 * PASS_TO_PASS).
 */
export async function runBenchSweLite(opts: BenchOptions): Promise<void> {
  const projectRoot = process.cwd();
  const tasksPath = path.resolve(projectRoot, opts.tasks);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const outputPath = path.resolve(projectRoot, opts.output ?? 'predictions.json');

  let tasks: SweBenchTask[];
  try {
    tasks = SweBenchLoader.load(tasksPath, limit);
  } catch (err) {
    console.error('  ' + (err as Error).message);
    process.exit(1);
  }

  console.log(`\n  SWE-bench Lite — ${tasks.length} task(s) loaded from ${opts.tasks}`);

  if (opts.dryRun) {
    for (const task of tasks) {
      console.log(`  · ${task.instance_id}  (${task.repo}@${task.base_commit.slice(0, 7)})`);
    }
    console.log('\n  Dry run — no loom invocations made.\n');
    return;
  }

  const loomBin = resolveLoomBin();
  const policyOverrides = collectPolicyOverrides(opts);
  if (Object.keys(policyOverrides).length > 0) {
    console.log('  Policy overrides applied per task:');
    for (const [key, val] of Object.entries(policyOverrides)) {
      console.log(`    ${key}: ${val}`);
    }
    console.log('');
  }
  const runner = new SweBenchRunner({
    preserveFailures: opts.preserveFailures,
    preserveAll: opts.preserveAll,
    runLoom: async ({ repoDir, task }) => {
      try {
        execFileSync(loomBin, ['init'], { cwd: repoDir, stdio: 'inherit' });
        if (Object.keys(policyOverrides).length > 0) {
          patchPolicy(repoDir, policyOverrides);
        }
        // Plan → approve → run, unattended. The bench operates in a
        // fresh per-task tempdir so the approve-all-planned call only
        // ever sees this run's epic.
        execFileSync(
          loomBin,
          ['epic', task.problem_statement],
          { cwd: repoDir, stdio: 'inherit' }
        );
        execFileSync(loomBin, ['approve'], { cwd: repoDir, stdio: 'inherit' });
        execFileSync(loomBin, ['run'], { cwd: repoDir, stdio: 'inherit' });
        const commitCount = countCommitsAhead(repoDir, task.base_commit);
        return { commitCount };
      } catch (err) {
        return { commitCount: 0, error: (err as Error).message };
      }
    },
  });

  // Write predictions incrementally after every task. A bench run can take
  // hours; a crash on task N must not lose tasks 0..N-1. writePredictions is
  // idempotent — each call overwrites with the current accumulated state.
  const results: SweBenchTaskResult[] = [];
  const modelName = opts.modelName ?? 'loom';
  for (const task of tasks) {
    const result = await runner.runOne(task);
    results.push(result);
    writePredictions(outputPath, results, modelName);
    if (result.error) {
      console.log(`    ✗ ${task.instance_id}: ${result.error}`);
    } else if (result.patch.length === 0) {
      console.log(`    – ${task.instance_id}: empty patch`);
    } else {
      console.log(
        `    ✓ ${task.instance_id}: ${result.commitCount} commit(s), ` +
          `${formatBytes(result.patch.length)} diff in ${(result.durationMs / 1000).toFixed(1)}s`
      );
    }
  }

  const produced = results.filter((r) => r.patch.length > 0).length;
  const failed = results.filter((r) => r.error).length;
  console.log('');
  console.log(`  Wrote ${results.length} prediction(s) to ${outputPath}`);
  console.log(`  Produced patches: ${produced}/${results.length}`);
  console.log(`  Errored before patch: ${failed}`);

  // Surface preserved failure tempdirs so the operator can find them
  // without scrolling back through the per-task log.
  const preserved = results.filter((r) => r.preservedPath);
  if (preserved.length > 0) {
    console.log('');
    const label = opts.preserveAll ? 'tempdirs' : 'failure tempdirs';
    console.log(`  Preserved ${label} (${preserved.length}):`);
    for (const r of preserved) {
      console.log(`    ${r.instanceId}  ${r.preservedPath}`);
    }
    console.log('  Clean these up manually when you\'re done diagnosing.');
  }
  console.log('');
  console.log('  Next: run the official harness against the predictions file:');
  console.log('    uv run --with swebench python -m swebench.harness.run_evaluation \\');
  console.log(`      --predictions_path ${path.relative(projectRoot, outputPath)} \\`);
  console.log('      --max_workers 4 \\');
  console.log(`      --run_id loom-$(date +%Y%m%d-%H%M%S)`);
  console.log('');
}

function resolveLoomBin(): string {
  // The bench needs the SAME loom that this bench harness was built from,
  // not whatever `loom` happens to be on PATH. Stale global installs
  // (eg loom-ai@0.2.2 still living in ~/.nvm/.../node_modules/) would
  // silently take over the spawned `loom init / epic / approve / run`
  // calls and run pre-fix code under the new bench's assumptions — every
  // PR that touched loom-core's policy schema or refiner would be
  // bypassed, with no error signal until tasks fail in subtle ways.
  //
  // The actual entry point ships at `dist/index.js` per package.json's
  // `bin: { loom: 'dist/index.js' }`. From this compiled module at
  // `dist/dev-scripts/bench.js`, that's one directory up. Resolve and
  // log; only fall through to PATH if the dist binary genuinely isn't
  // there (eg invocation from a non-built tree), and log THAT too so it
  // doesn't go unnoticed.
  const candidate = path.resolve(__dirname, '../index.js');
  if (fs.existsSync(candidate)) {
    console.log(`  loom (spawned): ${candidate}`);
    return candidate;
  }
  console.warn(
    `  warning: dist/index.js not found at ${candidate} — falling back to PATH 'loom'. ` +
      `Spawned subprocesses may run a stale/unrelated install.`,
  );
  return 'loom';
}

function countCommitsAhead(repoDir: string, base: string): number {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${base}..HEAD`], {
      cwd: repoDir,
      encoding: 'utf8',
    }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function collectPolicyOverrides(opts: BenchOptions): Record<string, string | number> {
  // SWE-bench problem statements are pre-structured GitHub issues; loom's
  // brief-quality rubric is tuned for prose briefs and over-critiques
  // them. Set the threshold to 0 — the bench's documented purpose is to
  // measure planner+worker quality, not the refiner's judgment of a
  // real-world issue body, and the refiner regularly floors at 0/10 on
  // these inputs (observed in iter-2 on django-11019 and in a smoke run
  // on astropy-12907). Threshold 0 means any score passes, which is the
  // intent.
  //
  // The accompanying schema change to z.number().int().min(0) is what
  // lets this value through PolicyEngine.load — without that, PR #50
  // crashed every task with "Number must be greater than or equal to 1".
  const out: Record<string, string | number> = {
    min_brief_quality_score: 0,
  };
  if (opts.reviewStrategy) out.review_strategy = opts.reviewStrategy;
  if (opts.skillGeneration) out.skill_generation = opts.skillGeneration;
  if (opts.reviewModel) out.review_model = opts.reviewModel;
  if (opts.reviewModelId) out.review_model_id = opts.reviewModelId;
  if (opts.reviewReviseTrigger) out.review_revise_trigger = opts.reviewReviseTrigger;
  return out;
}

/**
 * Surgically edits `.loom/policy.yaml` under the given repo to override
 * specific keys inside the `agents:` block. Implemented as a regex replace
 * to avoid pulling in a full YAML parser for one operation; the format
 * shipped by `loom init` is stable and the keys are unambiguous.
 *
 * Throws if a target key isn't found — running with an override that
 * silently failed to apply would produce misleading bench results.
 */
export function patchPolicy(
  repoDir: string,
  overrides: Record<string, string | number>,
): void {
  const policyPath = path.join(repoDir, '.loom', 'policy.yaml');
  if (!fs.existsSync(policyPath)) {
    throw new Error(`bench: policy.yaml not found at ${policyPath} after loom init`);
  }
  let content = fs.readFileSync(policyPath, 'utf8');
  for (const [key, value] of Object.entries(overrides)) {
    // Numbers must land unquoted — the policy Zod schema expects native
    // numeric types (e.g. min_brief_quality_score is z.number()); a quoted
    // "1" parses as a YAML string and fails validation. Strings stay
    // quoted to neutralize YAML 1.1 keyword surprises ('on'/'off' booleans).
    const yamlValue = typeof value === 'number' ? String(value) : `"${value}"`;
    // Match "  <key>: ..." or "# ... <key>: ..." (commented), with either
    // a quoted string value or an unquoted scalar (number / identifier).
    // Replace with an active line. Trailing comments are dropped.
    const re = new RegExp(`(^|\\n)\\s*#?\\s*${key}:\\s*(?:"[^"]*"|[^\\n#]+)`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `\n  ${key}: ${yamlValue}`);
    } else {
      // Fallback: append under the agents: block. If we can't find it, error.
      const agentsRe = /\nagents:\n/;
      if (!agentsRe.test(content)) {
        throw new Error(`bench: cannot locate 'agents:' section in policy.yaml to add ${key}`);
      }
      content = content.replace(agentsRe, `\nagents:\n  ${key}: ${yamlValue}\n`);
    }
  }
  fs.writeFileSync(policyPath, content);
}
