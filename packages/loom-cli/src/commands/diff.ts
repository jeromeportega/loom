import type { CommandDescription } from '../describe/schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EpicStore, AgentStore } from '@loom-ai/core';
import { openProjectDatabase } from '../dbHelper.js';

const execFileP = promisify(execFile);

export interface DiffOptions {
  maxBytes?: number;
  /** commander `--no-stat` sets this to false; default true. */
  stat?: boolean;
  json?: boolean;
}

/**
 * `loom diff <id>` — `git diff <epic.base_sha>..<branch>` for a story or epic.
 * `<id>` is a story id (`story-…`) or epic id (`epic-…`). Read-only.
 */
export async function runDiff(id: string, opts: DiffOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const loomDir = path.join(projectRoot, '.loom');
  if (!fs.existsSync(path.join(loomDir, 'policy.yaml'))) {
    console.error('loom is not initialized in this directory. Run `loom init` first.');
    process.exit(1);
  }

  const db = openProjectDatabase(projectRoot);
  const epicStore = new EpicStore(db);
  const agentStore = new AgentStore(db);
  const maxBytes = opts.maxBytes ?? 200_000;
  const includeStat = opts.stat !== false;

  let epicId: string;
  let branch: string;
  if (id.startsWith('story-')) {
    const agent = agentStore.getByStory(id);
    if (!agent) {
      console.error(`No agent for story "${id}".`);
      process.exit(1);
      return;
    }
    epicId = agent.epic_id;
    branch = `story/${agent.story_id}`;
  } else if (id.startsWith('epic-')) {
    epicId = id;
    branch = `epic/${id}`;
  } else {
    console.error('Pass a story id (story-XXX-YYY) or an epic id (epic-XXX).');
    process.exit(1);
    return;
  }

  const epic = epicStore.get(epicId);
  if (!epic || !epic.base_sha) {
    console.error(`Epic "${epicId}" has no base_sha — was it dispatched?`);
    process.exit(1);
    return;
  }

  const range = `${epic.base_sha}..${branch}`;
  let diff: string;
  try {
    const res = await execFileP('git', ['--no-pager', 'diff', range], {
      cwd: projectRoot,
      maxBuffer: 50_000_000,
    });
    diff = res.stdout;
  } catch (err) {
    console.error(`git diff ${range} failed: ${(err as Error).message}`);
    process.exit(1);
    return;
  }

  const truncated = diff.length > maxBytes;
  const body = truncated ? diff.slice(0, maxBytes) : diff;
  let stat: string | undefined;
  if (includeStat) {
    try {
      const res = await execFileP('git', ['--no-pager', 'diff', '--stat', range], {
        cwd: projectRoot,
        maxBuffer: 256_000,
      });
      stat = res.stdout;
    } catch {
      // stat is best-effort; the diff body is the load-bearing output.
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        { base: epic.base_sha, head: branch, bytes: diff.length, truncated, diff: body, ...(stat ? { stat } : {}) },
        null,
        2
      )
    );
    return;
  }

  if (stat) process.stdout.write(stat.endsWith('\n') ? stat : stat + '\n');
  process.stdout.write(body);
  if (!body.endsWith('\n')) process.stdout.write('\n');
  if (truncated) {
    console.error(`  … truncated at ${maxBytes} bytes (total ${diff.length}). Raise with --max-bytes.`);
  }
}

export const spec: CommandDescription = {
  name: 'diff',
  summary: 'Show a story or epic diff (git diff base..branch)',
  whenToUse: 'Use to inspect the exact changes a story or epic branch made, before or after review.',
  arguments: [
    { name: 'id', type: 'string', required: true, description: 'Story id (story-XXX-YYY) or epic id (epic-XXX)' },
  ],
  options: [
    { name: '--max-bytes', type: 'number', description: 'Truncate the diff body at N bytes (default 200000)', changesOutputShape: false },
    { name: '--no-stat', type: 'boolean', description: 'Omit the leading --stat summary', changesOutputShape: false },
    { name: '--json', type: 'boolean', description: 'Emit JSON: { base, head, bytes, truncated, diff, stat }', changesOutputShape: true },
  ],
  output: {
    text: 'Git diff output with optional stat summary',
    json: { supported: true, shape: '{ base: string, head: string, bytes: number, truncated: boolean, diff: string, stat: string }' },
  },
  examples: [
    { command: 'loom diff story-001-003', description: 'Show the diff for story-001-003' },
    { command: 'loom diff epic-001 --json', description: 'Emit the epic diff as JSON' },
    { command: 'loom diff story-001-003 --no-stat', description: 'Show diff without the file-change summary' },
  ],
  exitCodes: [
    { code: 0, meaning: 'Diff printed successfully' },
    { code: 1, meaning: 'Story or epic not found, or git error' },
  ],
  errors: ['Story or epic not found', 'git error — ensure the repo is initialized'],
  relationships: { prerequisites: ['run'], nextSteps: ['review', 'status'] },
};
