#!/usr/bin/env node
/**
 * `loom-bench` — developer-tool entry point for the SWE-bench Lite runner
 * and its analyzers (classify / compare / variance). Deliberately kept
 * separate from the user-facing `loom` CLI: benchmarks are for tuning
 * loom itself, not for everyday operator use.
 *
 * Run via the installed binary (`loom-bench swe-bench-lite ...`) or
 * directly with node against the built dist file.
 */
import { Command } from 'commander';
import { runBenchSweLite } from './dev-scripts/bench.js';
import { runBenchClassify, type BenchClassifyOptions } from './dev-scripts/benchClassify.js';
import { runBenchCompare, type BenchCompareOptions } from './dev-scripts/benchCompare.js';
import { runBenchVariance, type BenchVarianceOptions } from './dev-scripts/benchVariance.js';

const program = new Command();

program
  .name('loom-bench')
  .description('Loom developer benchmark runner — SWE-bench Lite end-to-end and analyzers');

program
  .command('swe-bench-lite')
  .description('Run loom against SWE-bench Lite tasks and emit predictions.json')
  .requiredOption('--tasks <path>', 'Path to the SWE-bench Lite JSON file (download from HuggingFace)')
  .option('--limit <n>', 'Max tasks to run (default: 10)', (v: string) => parseInt(v, 10), 10)
  .option('--output <path>', 'Where to write predictions.json (default: ./predictions.json)')
  .option('--dry-run', 'List the tasks that would run, then exit')
  .option('--model-name <name>', 'Value to embed in predictions.json (default: "loom")')
  .option(
    '--review-strategy <mode>',
    'Override policy.agents.review_strategy per task: off | comment | block-and-revise'
  )
  .option(
    '--skill-generation <mode>',
    'Override policy.agents.skill_generation per task: on | off | sampled. Use "off" to isolate tasks from cross-bench candidate-skill pollution.'
  )
  .option(
    '--preserve-failures',
    'Keep the tempdir of any failed task (errored or empty patch) for post-mortem inspection. The paths are printed in the summary. Successful tasks always clean up.'
  )
  .option(
    '--preserve-all',
    'Keep every task tempdir, even ones loom marks successful. Implies --preserve-failures; disk usage scales with task count.'
  )
  .option(
    '--review-model <mode>',
    "Override policy.agents.review_model per task: 'same' (default) | 'cross'. Pair with --review-model-id when cross."
  )
  .option(
    '--review-model-id <id>',
    "Cursor-CLI model id used when --review-model=cross (e.g. 'claude-opus-4-7-medium')."
  )
  .option(
    '--review-revise-trigger <mode>',
    "Override policy.agents.review_revise_trigger per task: 'blockers' (default) | 'any'."
  )
  .action(
    async (opts: {
      tasks: string;
      limit?: number;
      output?: string;
      dryRun?: boolean;
      modelName?: string;
      reviewStrategy?: 'off' | 'comment' | 'block-and-revise';
      skillGeneration?: 'on' | 'off' | 'sampled';
      preserveFailures?: boolean;
      preserveAll?: boolean;
      reviewModel?: 'same' | 'cross';
      reviewModelId?: string;
      reviewReviseTrigger?: 'blockers' | 'any';
    }) => {
      await runBenchSweLite(opts);
    }
  );

program
  .command('classify')
  .description("Classify a bench run's per-task failure modes from predictions + harness report + (optional) preserved tempdirs.")
  .argument('<predictions>', 'Path to the bench predictions.json file')
  .option('--report <path>', 'Path to the harness report (loom.loom-<runid>.json). Without it, harness_status is "unknown".')
  .option('--manifest <path>', 'Sidecar JSON mapping instance_id → tempdir path')
  .option('--tempdirs <pairs...>', 'Repeatable instance_id=path entries')
  .option('--json', 'Emit structured JSON instead of the human-readable text report')
  .action((predictions: string, opts: BenchClassifyOptions) => {
    runBenchClassify(predictions, opts);
  });

program
  .command('compare')
  .description("Per-task delta between two bench runs. Shows held / gained / regressed / shifted with failure-mode tags.")
  .argument('<a-predictions>', 'Run A predictions.json')
  .argument('<b-predictions>', 'Run B predictions.json')
  .option('--report-a <path>', 'Harness report for run A')
  .option('--report-b <path>', 'Harness report for run B')
  .option('--manifest-a <path>', 'Sidecar JSON mapping instance_id → tempdir for run A')
  .option('--manifest-b <path>', 'Sidecar JSON mapping instance_id → tempdir for run B')
  .option('--tempdirs-a <pairs...>', 'instance_id=path entries for run A')
  .option('--tempdirs-b <pairs...>', 'instance_id=path entries for run B')
  .option('--json', 'Emit structured JSON instead of the human-readable text report')
  .action((a: string, b: string, opts: BenchCompareOptions) => {
    runBenchCompare(a, b, opts);
  });

program
  .command('variance')
  .description("Outcome distribution across K runs of the same task set. Quantifies the noise floor.")
  .requiredOption('--predictions <files...>', 'K predictions.json files (parallel-indexed with --reports / --manifests when provided)')
  .option('--reports <files...>', 'K harness reports (loom.loom-<runid>.json).')
  .option('--manifests <files...>', 'K manifest sidecars mapping instance_id → tempdir, parallel-indexed')
  .option('--json', 'Emit structured JSON instead of the human-readable text report')
  .action((opts: BenchVarianceOptions) => {
    runBenchVariance(opts);
  });

program.parse();
