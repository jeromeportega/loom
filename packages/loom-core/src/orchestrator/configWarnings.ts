import type { Policy } from '../types.js';

/**
 * Loud startup warning for a self-defeating stall/cap configuration on the
 * cursor-cli worker backend.
 *
 * The progress-aware story timeout kills a worker after `story_stall_minutes`
 * of ZERO output activity OR after `story_absolute_cap_minutes` total. The
 * cursor-cli backend only resets the stall timer on real output, so a stall
 * budget set below the absolute cap means a healthy-but-quiet worker is killed
 * for stalling long before its genuine cap — a false kill.
 *
 * Per ADR-5 we warn and never rewrite `story_stall_minutes`: silently
 * defaulting it to the cap would weaken the genuine-silence protection the
 * stall timer exists to provide. Returns `undefined` (no warning) for every
 * configuration except the exact self-defeating cursor-cli case.
 */
export function stallConfigWarning(policy: Policy): string | undefined {
  const { worker_backend, story_stall_minutes, story_absolute_cap_minutes } =
    policy.agents;
  if (worker_backend !== 'cursor-cli') return undefined;
  if (story_stall_minutes >= story_absolute_cap_minutes) return undefined;

  return (
    `policy.agents.story_stall_minutes (${story_stall_minutes}) is below ` +
    `story_absolute_cap_minutes (${story_absolute_cap_minutes}) on the cursor-cli ` +
    'worker backend. The stall timer kills a worker after that many minutes of ' +
    'zero output activity, so a healthy worker that is quietly making progress ' +
    `can be falsely killed at ${story_stall_minutes} min — well before its ` +
    `${story_absolute_cap_minutes}-min cap. Raise story_stall_minutes to reduce ` +
    'false kills, or set it equal to story_absolute_cap_minutes to disable ' +
    'stall-based kills entirely.'
  );
}
