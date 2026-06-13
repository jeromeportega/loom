import type Database from 'better-sqlite3';
import type { AuditLog } from '../state/AuditLog.js';
import type { Signal, SignalSource } from './types.js';

export interface ScanContext {
  db: Database.Database;
  projectRoot: string;
  auditLog: AuditLog;
}

export interface SignalScanner {
  readonly source: SignalSource;
  /** MUST NOT throw on environmental failure: return [] + write an audit note. */
  scan(ctx: ScanContext): Promise<Signal[]>;
}
