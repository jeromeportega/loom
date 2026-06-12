import fs from 'node:fs';
import { SweBenchTaskSchema, type SweBenchTask } from './types.js';

/**
 * Reads SWE-bench Lite task rows from a JSON file the operator downloaded
 * from HuggingFace. Accepts either an array of rows (the standard shape)
 * or the HuggingFace dataset-server `{rows: [{row: {...}}]}` wrapper.
 *
 * The loom harness deliberately does NOT fetch from HuggingFace at runtime
 * — operators download the dataset once, point loom at the file, and we
 * stay free of network dependencies + HF rate limits.
 */
export class SweBenchLoader {
  /** Loads the dataset file. Validates each row; throws on the first malformed entry. */
  static load(filePath: string, limit?: number): SweBenchTask[] {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `SWE-bench dataset not found at ${filePath}. Download from ` +
          'https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite ' +
          '(the JSON export of the `test` split).'
      );
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const rows = unwrap(parsed);

    const tasks: SweBenchTask[] = [];
    for (const row of rows) {
      tasks.push(SweBenchTaskSchema.parse(row));
      if (limit !== undefined && tasks.length >= limit) break;
    }
    return tasks;
  }
}

/** Accepts both the bare array shape and the HF dataset-server wrapper. */
function unwrap(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'rows' in parsed &&
    Array.isArray((parsed as { rows: unknown[] }).rows)
  ) {
    return (parsed as { rows: unknown[] }).rows.map((entry) => {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        'row' in entry &&
        (entry as { row: unknown }).row !== undefined
      ) {
        return (entry as { row: unknown }).row;
      }
      return entry;
    });
  }
  throw new Error(
    'SWE-bench dataset file must be either an array of task rows or ' +
      'a `{rows: [{row: {...}}]}` HF dataset-server response.'
  );
}
