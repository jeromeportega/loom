import type { SkillSource, SkillLifecycle as SkillLifecycleStatus } from './SkillStore.js';

/**
 * High-level events from the self-learning loop. Mirrors the WorkerEvent
 * pattern: the Supervisor emits these so the CLI / pi dashboard can show what
 * the skill machinery is doing — selection, generation, promotion, demotion —
 * which otherwise runs silently.
 */
export type SkillEvent =
  | {
      type: 'injected';
      skillName: string;
      storyId: string;
      agentId: string;
      source: SkillSource;
      lifecycle: SkillLifecycleStatus;
      /**
       * For generated skills: the story id that produced this skill,
       * read from `metadata.generated_from_story_id`. Lets a consumer
       * close the loop visibly — "candidate X is here because story Y
       * generated it." Undefined for hand-authored skills.
       */
      generatedFromStoryId?: string;
    }
  | {
      type: 'generated';
      skillName: string;
      storyId: string;
    }
  | {
      type: 'promoted';
      skillName: string;
      from: SkillLifecycleStatus;
      to: SkillLifecycleStatus;
      reason: string;
    }
  | {
      type: 'demoted';
      skillName: string;
      from: SkillLifecycleStatus;
      to: SkillLifecycleStatus;
      reason: string;
    };

export type SkillEventCallback = (event: SkillEvent) => void;
