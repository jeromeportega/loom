import { EMPTY_USAGE } from './LLMClient.js';
import type { LLMClient, LLMRequest, LLMResponse } from './LLMClient.js';

export type MockResponder = (req: LLMRequest) => string;

/**
 * Deterministic LLMClient for tests. Construct with either:
 *  - a queue of strings (returned FIFO), or
 *  - a responder function that derives the reply from the request.
 *
 * Records every request it received for assertions.
 */
export class MockLLMClient implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private queue: string[] = [];
  private responder?: MockResponder;

  constructor(responses: string[] | MockResponder) {
    if (typeof responses === 'function') {
      this.responder = responses;
    } else {
      this.queue = [...responses];
    }
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);

    let text: string;
    if (this.responder) {
      text = this.responder(req);
    } else {
      const next = this.queue.shift();
      if (next === undefined) {
        throw new Error('MockLLMClient: no more scripted responses in queue');
      }
      text = next;
    }

    return {
      text,
      model: req.model,
      stopReason: 'end_turn',
      usage: { ...EMPTY_USAGE },
    };
  }

  /** True if every system block flagged `cache: true` was sent on every call. */
  allCacheableBlocksMarked(): boolean {
    return this.requests.every((r) =>
      r.system.some((b) => b.cache === true)
    );
  }
}
