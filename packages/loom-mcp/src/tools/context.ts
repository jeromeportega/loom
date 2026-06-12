import type {
  LLMClient,
  WorkerRunner,
  LLMBackend,
  WorkerFactoryOptions,
  CreateLLMOptions,
} from '@loom-ai/core';

/**
 * Dependencies a tool handler needs. The LLM and worker are supplied via
 * factories so tests can inject mocks while production uses the real
 * session-based / API clients and the configured worker backend.
 */
export interface ToolContext {
  projectRoot: string;
  loomDir: string;
  /** Builds the LLM client for the configured backend (session or API). */
  createLLM: (backend: LLMBackend, opts?: CreateLLMOptions) => LLMClient;
  /** Builds the worker runner for the configured backend. */
  createWorker: (opts: WorkerFactoryOptions) => WorkerRunner;
  /**
   * Sink for fire-and-forget background work (e.g. epic dispatch after
   * approval). Production logs failures; tests collect the promises to await.
   */
  background: (label: string, work: Promise<unknown>) => void;
}

/** A tool handler: takes validated args, returns a JSON-serializable result. */
export type ToolHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>
) => Promise<unknown>;
