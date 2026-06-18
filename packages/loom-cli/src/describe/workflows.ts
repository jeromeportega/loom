import type { Workflow } from './schema.js';

export const WORKFLOWS: Workflow[] = [
  {
    id: 'plan',
    goal: 'Plan a new epic from a brief, approve it, and dispatch story agents',
    steps: [
      {
        command: 'epic',
        why: 'Run the Analyst → PM → Architect pipeline to produce the epic plan from a brief',
      },
      {
        command: 'approve',
        why: 'Review the generated plan and release it for agent execution',
      },
      {
        command: 'run',
        why: 'Dispatch story agents for the approved epic',
      },
    ],
  },
  {
    id: 'approve',
    goal: 'Approve a planned epic and release it for agent execution',
    steps: [
      {
        command: 'approve',
        why: 'Release one or all planned epics so story agents can be dispatched',
      },
    ],
  },
  {
    id: 'run',
    goal: 'Dispatch story agents for all approved epics',
    steps: [
      {
        command: 'run',
        why: 'Start the supervisor to dispatch story agents for every approved epic',
      },
    ],
  },
  {
    id: 'status',
    goal: 'Check current epic and story progress',
    steps: [
      {
        command: 'status',
        why: 'Show epic and per-story status with PR links to monitor agent progress',
      },
    ],
  },
  {
    id: 'retry',
    goal: 'Retry a failed or blocked story',
    steps: [
      {
        command: 'retry',
        why: 'Reset the failed or blocked story and re-dispatch it with a fresh auto-retry budget',
      },
    ],
  },
  {
    id: 'reconcile',
    goal: 'Reconcile a stranded-but-merged epic to done state',
    steps: [
      {
        command: 'reconcile',
        why: 'Verify the PR was merged and flip the epic status to done',
      },
    ],
  },
];
