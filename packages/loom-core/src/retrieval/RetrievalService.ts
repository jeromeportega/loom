import type { Policy } from '../types.js';
import type { AuditLog } from '../state/AuditLog.js';
import type { RetrievalRequest, SearchResult, ReadResult } from './types.js';
import { RetrievalRefused, CROSS_REPO_RULES } from './types.js';
import { resolveRegisteredRepo } from './ManifestResolver.js';
import { loadSliceBounds } from './SliceBounds.js';
import { readBounded } from './RepoReader.js';
import { searchBounded } from './RepoSearcher.js';

export class RetrievalService {
  constructor(
    private readonly loomHome: string,
    private readonly policy: Policy,
    private readonly audit: AuditLog,
  ) {}

  search(req: Extract<RetrievalRequest, { kind: 'search' }>): SearchResult {
    const auditDetail: Record<string, unknown> = {
      kind: 'search',
      slug: req.slug,
      query: req.query,
    };
    if (req.pathGlob !== undefined) auditDetail.pathGlob = req.pathGlob;

    if (!this.policy.cross_repo.enabled) {
      const refused = new RetrievalRefused(
        'cross_repo.disabled',
        'cross-repo retrieval is disabled; set cross_repo.enabled=true in policy.yaml to enable',
      );
      this.audit.record({
        action: 'cross_repo_search',
        command: req.slug,
        allowed: false,
        policy_rule: refused.rule,
        detail: auditDetail,
      });
      throw refused;
    }

    let result: SearchResult;
    try {
      const repo = resolveRegisteredRepo(this.loomHome, req.slug);
      const bounds = loadSliceBounds(this.policy);
      result = searchBounded(
        repo,
        req.query,
        req.pathGlob,
        bounds,
        this.policy.cross_repo.secret_globs,
      );
    } catch (err) {
      const refused = err instanceof RetrievalRefused
        ? err
        : new RetrievalRefused(CROSS_REPO_RULES.UNREGISTERED, String(err));
      this.audit.record({
        action: 'cross_repo_search',
        command: req.slug,
        allowed: false,
        policy_rule: refused.rule,
        detail: auditDetail,
      });
      throw refused;
    }

    this.audit.record({
      action: 'cross_repo_search',
      command: req.slug,
      allowed: true,
      detail: { ...auditDetail, matches: result.matches.length, truncated: result.truncated },
    });
    return result;
  }

  read(req: Extract<RetrievalRequest, { kind: 'read' }>): ReadResult {
    const auditDetail: Record<string, unknown> = {
      kind: 'read',
      slug: req.slug,
      path: req.path,
    };
    if (req.lines !== undefined) auditDetail.lines = req.lines;

    if (!this.policy.cross_repo.enabled) {
      const refused = new RetrievalRefused(
        'cross_repo.disabled',
        'cross-repo retrieval is disabled; set cross_repo.enabled=true in policy.yaml to enable',
      );
      this.audit.record({
        action: 'cross_repo_read',
        command: req.slug,
        allowed: false,
        policy_rule: refused.rule,
        detail: auditDetail,
      });
      throw refused;
    }

    let result: ReadResult;
    try {
      const repo = resolveRegisteredRepo(this.loomHome, req.slug);
      const bounds = loadSliceBounds(this.policy);
      result = readBounded(
        repo,
        req.path,
        req.lines,
        bounds,
        this.policy.cross_repo.secret_globs,
      );
    } catch (err) {
      const refused = err instanceof RetrievalRefused
        ? err
        : new RetrievalRefused(CROSS_REPO_RULES.STALE_PATH, String(err));
      this.audit.record({
        action: 'cross_repo_read',
        command: req.slug,
        allowed: false,
        policy_rule: refused.rule,
        detail: auditDetail,
      });
      throw refused;
    }

    this.audit.record({
      action: 'cross_repo_read',
      command: req.slug,
      allowed: true,
      detail: { ...auditDetail, window: result.window, truncated: result.truncated },
    });
    return result;
  }
}
