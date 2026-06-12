import fs from 'node:fs';
import matter from 'gray-matter';
import type { SkillUsageStore } from '../state/index.js';
import { SkillStore, type SkillManifest, type SkillLifecycle as Lifecycle } from './SkillStore.js';

// Lifecycle tuning is an engineering call, not an operator knob. The
// thresholds below were calibrated against the loom-bench skill loop and
// shouldn't drift without a measurement; if you find yourself wanting to
// tune them per repo, treat that as signal to instrument first.
const DEFAULT_PROMOTE_AFTER = 3;
const DEFAULT_DEMOTE_FAILURE_RATIO = 0.5;
const DEFAULT_DEMOTE_MIN_SAMPLES = 3;

export interface SkillLifecycleOptions {
  skillStore: SkillStore;
  usageStore: SkillUsageStore;
  /** A candidate with this many successes and no failures is promoted to active. Defaults to 3. */
  promoteAfter?: number;
  /** An active skill is demoted when failed/injected reaches this ratio. Defaults to 0.5. */
  demoteFailureRatio?: number;
  /** Minimum injections before demotion can trigger (avoids tiny-sample noise). Defaults to 3. */
  demoteMinSamples?: number;
}

export interface LifecycleChange {
  skill: string;
  from: Lifecycle;
  to: Lifecycle;
  reason: string;
}

/**
 * The anti-degradation loop. Reads each generated skill's track record and
 * promotes proven candidates to 'active' or demotes failing skills to
 * 'disabled' — rewriting `metadata.lifecycle` in the SKILL.md. Hand-authored
 * (project/global) skills are never auto-managed.
 */
export class SkillLifecycle {
  constructor(private opts: SkillLifecycleOptions) {}

  /** Scans generated skills and applies promotions/demotions. */
  evaluate(): LifecycleChange[] {
    const promoteAfter = this.opts.promoteAfter ?? DEFAULT_PROMOTE_AFTER;
    const demoteFailureRatio = this.opts.demoteFailureRatio ?? DEFAULT_DEMOTE_FAILURE_RATIO;
    const demoteMinSamples = this.opts.demoteMinSamples ?? DEFAULT_DEMOTE_MIN_SAMPLES;
    const changes: LifecycleChange[] = [];
    for (const manifest of this.opts.skillStore.discover()) {
      if (manifest.source !== 'generated') continue;
      const tr = this.opts.usageStore.trackRecord(manifest.name);

      if (
        manifest.lifecycle === 'candidate' &&
        tr.succeeded >= promoteAfter &&
        tr.failed === 0
      ) {
        this.write(manifest, 'active');
        changes.push({
          skill: manifest.name,
          from: 'candidate',
          to: 'active',
          reason: `${tr.succeeded} successful injections, no failures`,
        });
      } else if (
        manifest.lifecycle === 'active' &&
        tr.injected >= demoteMinSamples &&
        tr.failed / tr.injected >= demoteFailureRatio
      ) {
        this.write(manifest, 'disabled');
        changes.push({
          skill: manifest.name,
          from: 'active',
          to: 'disabled',
          reason: `${tr.failed}/${tr.injected} injections failed`,
        });
      }
    }
    return changes;
  }

  /** Manual lifecycle override. Returns false if the skill is not found. */
  setLifecycle(skillName: string, status: Lifecycle): boolean {
    const manifest = this.opts.skillStore
      .discover()
      .find((m) => m.name === skillName);
    if (!manifest) return false;
    this.write(manifest, status);
    return true;
  }

  private write(manifest: SkillManifest, status: Lifecycle): void {
    const parsed = matter(fs.readFileSync(manifest.file, 'utf8'));
    const data = parsed.data as Record<string, unknown>;
    const metadata = {
      ...((data.metadata as Record<string, unknown>) ?? {}),
      lifecycle: status,
    };
    fs.writeFileSync(
      manifest.file,
      matter.stringify(parsed.content, { ...data, metadata })
    );
  }
}
