import type { EpicStore } from '../../state/EpicStore.js';

/**
 * Clears the checkpoint pause on an epic so it can continue dispatching.
 * Callers are responsible for re-dispatching via supervisor.run([epicId])
 * after this returns.
 */
export async function resumeEpic(
  deps: { epicStore: EpicStore },
  epicId: string
): Promise<{ status: 'dispatching' }> {
  deps.epicStore.resume(epicId);
  return { status: 'dispatching' };
}
