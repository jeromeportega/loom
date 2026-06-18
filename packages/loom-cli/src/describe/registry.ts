import type { Command } from 'commander';
import type { CommandDescription } from './schema.js';
import { spec as archiveSpec, specUnarchive } from '../commands/archive.js';
import { spec as artifactsSpec } from '../commands/artifacts.js';
import { spec as auditSpec } from '../commands/audit.js';
import { spec as autonomySpec } from '../commands/autonomy.js';
import { spec as diffSpec } from '../commands/diff.js';
import { spec as doctorSpec } from '../commands/doctor.js';
import { spec as epicSpec } from '../commands/epic.js';
import { spec as approveSpec, specReject } from '../commands/gate.js';
import { specCheck as guardCheckSpec, specHook as guardHookSpec } from '../commands/guard.js';
import { spec as guideSpec } from '../commands/guide.js';
import { spec as initSpec } from '../commands/init.js';
import { specList as mcpListSpec, specAdd as mcpAddSpec } from '../commands/mcp.js';
import { spec as projectSpec } from '../commands/project.js';
import { spec as projectsSpec } from '../commands/projects.js';
import { spec as proposeSpec } from '../commands/propose.js';
import { spec as pullGuidanceSpec } from '../commands/pullGuidance.js';
import { spec as reconcileSpec } from '../commands/reconcile.js';
import { spec as retrySpec } from '../commands/retry.js';
import { spec as revertSpec } from '../commands/revert.js';
import { spec as reviewSpec } from '../commands/review.js';
import { spec as runSpec } from '../commands/run.js';
import { spec as scanSpec, specOpportunities } from '../commands/scan.js';
import { spec as statusSpec } from '../commands/status.js';
import { spec as stopSpec } from '../commands/stop.js';
import { spec as tracesSpec } from '../commands/traces.js';
import { spec as webSpec } from '../commands/web.js';
import { spec as describeSpec } from '../commands/describeSpec.js';
import { spec as releaseSpec } from '../commands/release.js';
// <command specs>

/**
 * Returns the authored spec inventory: one CommandDescription per registered
 * command. The array is the single source of truth for all known commands.
 */
export function collectSpecs(): CommandDescription[] {
  return [
    archiveSpec,
    specUnarchive,
    artifactsSpec,
    auditSpec,
    autonomySpec,
    diffSpec,
    doctorSpec,
    epicSpec,
    approveSpec,
    specReject,
    guardCheckSpec,
    guardHookSpec,
    guideSpec,
    initSpec,
    mcpListSpec,
    mcpAddSpec,
    projectSpec,
    projectsSpec,
    proposeSpec,
    pullGuidanceSpec,
    reconcileSpec,
    retrySpec,
    revertSpec,
    reviewSpec,
    runSpec,
    scanSpec,
    specOpportunities,
    statusSpec,
    stopSpec,
    tracesSpec,
    webSpec,
    describeSpec,
    releaseSpec,
    // <command specs>
  ];
}

/**
 * Flattens program.commands recursively to full-path command names,
 * e.g. ["status", "run", "guard check", "mcp add", ...].
 * Shared by the manifest assembler and the completeness test.
 */
export function enumerateRegisteredCommands(program: Command): string[] {
  const names: string[] = [];

  function walk(cmd: Command, prefix: string): void {
    for (const sub of cmd.commands) {
      const fullName = prefix ? `${prefix} ${sub.name()}` : sub.name();
      if (sub.commands.length === 0) {
        names.push(fullName);
      }
      walk(sub, fullName);
    }
  }

  walk(program, '');
  return names;
}
