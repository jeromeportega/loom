import type { Policy } from '../types.js';
import type { AuditLog } from '../state/AuditLog.js';
import type { RetrievalRequest, SearchResult, ReadResult, ResolvedRepo } from './types.js';
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

    // Step 1: resolve slug — throws RetrievalRefused(UNREGISTERED) when not found.
    let repo: ResolvedRepo;
    try {
      repo = resolveRegisteredRepo(this.loomHome, req.slug);
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

    // Step 2: search — policy violations throw RetrievalRefused with the specific rule;
    // unexpected errors (I/O, git subprocess) are audited separately and re-thrown as-is
    // so the caller sees the real error rather than a misleading UNREGISTERED label.
    let result: SearchResult;
    try {
      const bounds = loadSliceBounds();
      result = searchBounded(repo, req.query, req.pathGlob, bounds, this.policy.cross_repo.secret_globs);
    } catch (err) {
      if (err instanceof RetrievalRefused) {
        this.audit.record({
          action: 'cross_repo_search',
          command: req.slug,
          allowed: false,
          policy_rule: err.rule,
          detail: auditDetail,
        });
        throw err;
      }
      this.audit.record({
        action: 'cross_repo_search',
        command: req.slug,
        allowed: false,
        policy_rule: 'cross_repo.internal_error',
        detail: { ...auditDetail, error: String(err) },
      });
      throw err;
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

    // Step 1: resolve slug — throws RetrievalRefused(UNREGISTERED) when not found.
    let repo: ResolvedRepo;
    try {
      repo = resolveRegisteredRepo(this.loomHome, req.slug);
    } catch (err) {
      const refused = err instanceof RetrievalRefused
        ? err
        : new RetrievalRefused(CROSS_REPO_RULES.UNREGISTERED, String(err));
      this.audit.record({
        action: 'cross_repo_read',
        command: req.slug,
        allowed: false,
        policy_rule: refused.rule,
        detail: auditDetail,
      });
      throw refused;
    }

    // Step 2: read — policy violations throw RetrievalRefused with the specific rule;
    // unexpected errors are audited separately and re-thrown as-is.
    let result: ReadResult;
    try {
      const bounds = loadSliceBounds();
      result = readBounded(repo, req.path, req.lines, bounds, this.policy.cross_repo.secret_globs);
    } catch (err) {
      if (err instanceof RetrievalRefused) {
        this.audit.record({
          action: 'cross_repo_read',
          command: req.slug,
          allowed: false,
          policy_rule: err.rule,
          detail: auditDetail,
        });
        throw err;
      }
      this.audit.record({
        action: 'cross_repo_read',
        command: req.slug,
        allowed: false,
        policy_rule: 'cross_repo.internal_error',
        detail: { ...auditDetail, error: String(err) },
      });
      throw err;
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
