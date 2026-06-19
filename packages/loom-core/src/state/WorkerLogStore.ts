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
  // Avoids a mkdirSync syscall on every chunk after the first append.
  private dirReady = false;
  // Tracks cumulative byte offsets per story to avoid TOCTOU races between
  // appendFileSync and a subsequent statSync, and to eliminate the extra stat call.
  private offsetMap = new Map<string, number>();

  constructor(loomdir: string) {
    this.logsDir = path.join(loomdir, 'logs');
  }

  /** Absolute path to the log file for a story. */
  pathFor(storyId: string): string {
    return path.join(this.logsDir, `${storyId}.log`);
  }

  /**
   * Appends redacted content to the story's log file.
   * Creates the file (and parent directory) if absent.
   * Returns the new cumulative post-redaction byte length (i.e. file size).
   */
  append(storyId: string, redacted: string): number {
    if (!this.dirReady) {
      fs.mkdirSync(this.logsDir, { recursive: true });
      this.dirReady = true;
    }
    const filePath = this.pathFor(storyId);
    const chunkBytes = Buffer.byteLength(redacted, 'utf8');
    fs.appendFileSync(filePath, redacted, 'utf8');
    const newOffset = (this.offsetMap.get(storyId) ?? 0) + chunkBytes;
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
   */
  read(storyId: string, fromOffset?: number, upTo?: number): Buffer {
    const filePath = this.pathFor(storyId);
    let fileSize: number;
    try {
      fileSize = fs.statSync(filePath).size;
    } catch {
      return Buffer.alloc(0);
    }
    const from = fromOffset ?? 0;
    const to = upTo ?? fileSize;
    if (from >= to) return Buffer.alloc(0);
    const len = to - from;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
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
