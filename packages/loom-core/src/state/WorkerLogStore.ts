import fs from 'node:fs';
import path from 'node:path';

/**
 * Owns path and offset semantics for per-story durable worker log files.
 *
 * Files live at <loomdir>/logs/<story-id>.log. Each chunk is appended
 * synchronously (reaching the OS page cache immediately). `append` returns
 * the cumulative post-redaction byte length, which is the single source of
 * truth for the durable offset written to agents.log_bytes.
 *
 * Reads are stateless: each consumer (loom-web routes, loom-web events)
 * constructs its own instance from the resolved loomdir.
 */
export class WorkerLogStore {
  private logsDir: string;
  // Tracks cumulative byte offsets per story. Seeded from the on-disk file
  // size on first access so a process restart does not undercount bytes already
  // written by a prior process. After seeding, maintained in-memory to avoid a
  // stat syscall per chunk and to prevent TOCTOU races.
  private offsetMap = new Map<string, number>();

  constructor(loomdir: string) {
    this.logsDir = path.join(loomdir, 'logs');
  }

  /** Absolute path to the log file for a story. */
  pathFor(storyId: string): string {
    if (storyId.includes('/') || storyId.includes('\\') || storyId.startsWith('.')) {
      throw new Error(`invalid storyId: ${storyId}`);
    }
    return path.join(this.logsDir, `${storyId}.log`);
  }

  /**
   * Appends redacted content to the story's log file.
   * Creates the file (and parent directory) if absent.
   * Returns the new cumulative post-redaction byte length (i.e. file size).
   *
   * On first access per story the accumulator is seeded from the on-disk file
   * size (0 when absent) so restarts after a partial run yield correct offsets.
   * The mkdirSync is unconditional so the class is resilient to external removal
   * of the logs directory (recursive: true makes it a no-op when it already exists).
   */
  append(storyId: string, redacted: string): number {
    fs.mkdirSync(this.logsDir, { recursive: true });
    if (!this.offsetMap.has(storyId)) {
      try {
        this.offsetMap.set(storyId, fs.statSync(this.pathFor(storyId)).size);
      } catch {
        this.offsetMap.set(storyId, 0);
      }
    }
    const filePath = this.pathFor(storyId);
    const chunkBytes = Buffer.byteLength(redacted, 'utf8');
    fs.appendFileSync(filePath, redacted, 'utf8');
    const newOffset = this.offsetMap.get(storyId)! + chunkBytes;
    this.offsetMap.set(storyId, newOffset);
    return newOffset;
  }

  /** Returns the file's current byte length, or 0 if absent. */
  byteLength(storyId: string): number {
    try {
      return fs.statSync(this.pathFor(storyId)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Returns bytes in the half-open range [fromOffset, upTo).
   * Defaults: fromOffset=0, upTo=file size. Returns an empty Buffer when
   * the file is absent or the range is empty.
   *
   * statSync is only called when upTo is not provided (avoids a wasted syscall
   * and a TOCTOU window on hot-path reads from loom-web where the range is known).
   * ENOENT on openSync returns an empty Buffer rather than throwing.
   */
  read(storyId: string, fromOffset?: number, upTo?: number): Buffer {
    const filePath = this.pathFor(storyId);
    const from = fromOffset ?? 0;
    let to: number;
    if (upTo !== undefined) {
      to = upTo;
    } else {
      try {
        to = fs.statSync(filePath).size;
      } catch {
        return Buffer.alloc(0);
      }
    }
    if (from >= to) return Buffer.alloc(0);
    const len = to - from;
    const buf = Buffer.alloc(len);
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw e;
    }
    try {
      const bytesRead = fs.readSync(fd, buf, 0, len, from);
      return buf.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Removes the log file if present. Idempotent. */
  remove(storyId: string): void {
    try {
      fs.unlinkSync(this.pathFor(storyId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
