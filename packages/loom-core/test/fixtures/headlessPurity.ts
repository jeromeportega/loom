import fs from 'node:fs';

/**
 * Path fragments that belong to the vendored BMAD runtime. A headless,
 * self-contained loom skill must never depend on them, so the fixture makes
 * any attempt to read these paths fail for the duration of `fn`.
 */
const HIDDEN_FRAGMENTS = ['_bmad/scripts', '_bmad/bmm/config.yaml'];

function isHidden(target: unknown): boolean {
  const normalized = String(target).split('\\').join('/');
  return HIDDEN_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function hiddenError(target: unknown): NodeJS.ErrnoException {
  const err = new Error(
    `ENOENT: hidden by headlessPurity fixture, '${String(target)}'`,
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  err.errno = -2;
  return err;
}

/** Wrap a fs method so reads of a hidden path fail; sync throws, async rejects. */
function guard(
  original: (...args: any[]) => any,
  mode: 'throw' | 'false',
  async: boolean,
): (...args: any[]) => any {
  if (async) {
    return async (p: unknown, ...rest: unknown[]) => {
      if (isHidden(p)) throw hiddenError(p);
      return original(p, ...rest);
    };
  }
  return (p: unknown, ...rest: unknown[]) => {
    if (isHidden(p)) {
      if (mode === 'false') return false;
      throw hiddenError(p);
    }
    return original(p, ...rest);
  };
}

/**
 * Runs `fn` with `_bmad/scripts/` and `_bmad/bmm/config.yaml` hidden from the
 * process: every sync or async read, existence check, or stat against those
 * paths fails. All fs methods are restored before returning, even if `fn`
 * throws. story-001 owns this fixture; story-007 reuses it.
 */
export async function withHiddenBmadPaths(fn: () => Promise<void>): Promise<void> {
  const sync = fs as unknown as Record<string, (...args: any[]) => any>;
  const promises = fs.promises as unknown as Record<string, (...args: any[]) => any>;

  const restore: Array<() => void> = [];
  const patchSync = (name: string, mode: 'throw' | 'false') => {
    const original = sync[name];
    sync[name] = guard(original, mode, false);
    restore.push(() => {
      sync[name] = original;
    });
  };
  const patchAsync = (name: string) => {
    const original = promises[name];
    promises[name] = guard(original, 'throw', true);
    restore.push(() => {
      promises[name] = original;
    });
  };

  patchSync('existsSync', 'false');
  patchSync('readFileSync', 'throw');
  patchSync('statSync', 'throw');
  patchSync('accessSync', 'throw');
  patchAsync('readFile');
  patchAsync('access');
  patchAsync('stat');

  try {
    await fn();
  } finally {
    for (const undo of restore) undo();
  }
}
