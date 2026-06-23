/**
 * Cross-project DB resolver — produced by story-003-004 (§7 of shared contract).
 *
 * makeResolveProjectDb() returns a per-request resolver that validates
 * ?project against ProjectRegistry BEFORE opening any DB (path-traversal
 * guard). Absent ?project resolves to the host project. Any project root not
 * present in the registry is rejected with a 400-coded error.
 *
 * The returned ResolvedProject includes a cleanup() function: noop for the
 * host DB, db.close() for peer connections. Callers MUST invoke it in a
 * finally block.
 *
 * Owner: story-003-004
 */

import path from 'node:path';
import fs from 'node:fs';
import type { Request } from 'express';
import type Database from 'better-sqlite3';
import {
  EpicStore,
  AgentStore,
  AuditLog,
  ProjectRegistry,
  PolicyEngine,
  createDatabase,
  resolveRepoStatePaths,
} from '@loom-ai/core';

export interface ResolvedProject {
  db: Database.Database;
  epicStore: EpicStore;
  agentStore: AgentStore;
  auditLog: AuditLog;
  /** Absolute path — passed as spawn cwd for `loom run`. */
  cwd: string;
  project_root: string;
  /** Callers MUST invoke in a finally block. Noop for host; closes DB for peers. */
  cleanup: () => void;
}

export type ResolveProjectDb = (req: Request) => ResolvedProject;

/**
 * Factory that binds a resolver to the host project's long-lived stores.
 * Host DB is never closed by the resolver; only fresh peer connections are.
 */
export function makeResolveProjectDb(
  hostDb: Database.Database,
  hostProjectRoot: string
): ResolveProjectDb {
  const hostEpicStore = new EpicStore(hostDb);
  const hostAgentStore = new AgentStore(hostDb);
  const hostAuditLog = new AuditLog(hostDb);

  return function resolveProjectDb(req: Request): ResolvedProject {
    const raw = req.query.project;

    if (typeof raw !== 'string' || raw.length === 0 || raw === hostProjectRoot) {
      return {
        db: hostDb,
        epicStore: hostEpicStore,
        agentStore: hostAgentStore,
        auditLog: hostAuditLog,
        cwd: hostProjectRoot,
        project_root: hostProjectRoot,
        cleanup: () => {},
      };
    }

    // Security: validate against registry BEFORE opening any file path.
    const known = new ProjectRegistry().list().map((e) => e.root);
    if (!known.includes(raw)) {
      const err = new Error(`unknown project root: ${raw}`);
      (err as NodeJS.ErrnoException).code = 'ENOTREGISTERED';
      throw Object.assign(err, { statusCode: 400 });
    }

    const peerLoomDir = path.join(raw, '.loom');
    let peerPolicy: { loom_home?: string };
    try {
      peerPolicy = PolicyEngine.load(peerLoomDir).policyData;
    } catch (loadErr) {
      // Log the full error (which may include absolute filesystem paths) server-side only.
      // Return a sanitized message to the client to avoid leaking internal path structure.
      console.error(`[resolveProjectDb] cannot load policy for project ${raw}:`, loadErr);
      throw Object.assign(
        new Error('cannot load policy for project — check server logs for details'),
        { statusCode: 400 },
      );
    }
    const { namespaceDir: peerNsDir } = resolveRepoStatePaths(raw, { loom_home: peerPolicy.loom_home ?? '' });
    const dbPath = path.join(peerNsDir, 'loom.db');
    if (!fs.existsSync(dbPath)) {
      throw Object.assign(
        new Error(`project DB not found: ${dbPath}`),
        { statusCode: 404 }
      );
    }

    const peerDb = createDatabase(dbPath);
    return {
      db: peerDb,
      epicStore: new EpicStore(peerDb),
      agentStore: new AgentStore(peerDb),
      auditLog: new AuditLog(peerDb),
      cwd: raw,
      project_root: raw,
      cleanup: () => peerDb.close(),
    };
  };
}
