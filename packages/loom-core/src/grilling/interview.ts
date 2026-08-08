import * as readline from 'node:readline';
import type { LLMClient, LLMRequest, LLMResponse } from '../llm/index.js';
import { factCheck } from './factCheck.js';
import type {
  GrillingDecision,
  InterviewResult,
  ProvenanceTag,
  ResolvedDecision,
} from './types.js';

export interface InterviewOptions {
  llm: LLMClient;
  model: string;
  repoRoot: string;
  /** Injected for tests — omit to use process.stdin / process.stdout. */
  rl?: readline.Interface;
}

const MAX_ROUNDS = 4;
const MAX_QUESTIONS = 20;
/** Bulk-accept tokens: accept the suggestion without an explicit answer. */
const BULK_ACCEPT = new Set(['', 'y', 'yes', 'a', 'accept']);
/** Safety bound so a stream that keeps yielding bulk-accept can't loop forever. */
const MAX_REPROMPTS = 5;

/**
 * Terminal interview that resolves the grilling decision tree with the operator.
 * Presents the frontier (decisions whose prerequisites are all resolved) in id
 * order, in rounds. High-blast decisions require an explicit answer (bulk-accept
 * is rejected); low-blast may be bulk-accepted. Lookup-able decisions are
 * fact-checked first (agentic, tools on) and the result pre-fills the suggestion.
 * At the round/question cap, unresolved low-blast decisions are auto-defaulted;
 * any unresolved high-blast decision cancels the run. Ctrl-C (readline close or
 * SIGINT) cancels, returning whatever was settled. `tokenCost` is the cumulative
 * usage of every factCheck call, captured via a wrapping LLM client.
 */
export async function runGrillingInterview(
  decisions: GrillingDecision[],
  opts: InterviewOptions,
): Promise<InterviewResult> {
  const ownRl = opts.rl === undefined;
  const rl =
    opts.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });

  let tokenCost = 0;
  const trackingLlm: LLMClient = {
    complete: async (req: LLMRequest): Promise<LLMResponse> => {
      const res = await opts.llm.complete(req);
      tokenCost += res.usage.inputTokens + res.usage.outputTokens;
      return res;
    },
  };

  const resolved = new Map<string, ResolvedDecision>();
  let cancelled = false;
  const onClose = (): void => {
    cancelled = true;
  };
  const onSigint = (): void => {
    cancelled = true;
    rl.close();
  };
  rl.on('close', onClose);
  process.once('SIGINT', onSigint);

  // Resolve to null when the interface closes (Ctrl-C / Ctrl-D / EOF) with the
  // prompt still pending. node:readline fires 'close' but NEVER invokes the
  // pending question callback, so without this the await would hang forever —
  // the `cancelled` flag is only checked between awaits and cannot un-suspend a
  // promise that never settles. A null return is the cancellation signal.
  const ask = (query: string): Promise<string | null> =>
    new Promise((resolve) => {
      let settled = false;
      const onQuestionClose = (): void => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
      rl.on('close', onQuestionClose);
      rl.question(query, (answer) => {
        if (settled) return;
        settled = true;
        rl.removeListener('close', onQuestionClose);
        resolve(answer);
      });
    });

  const finish = (outcome: 'completed' | 'cancelled'): InterviewResult => {
    rl.removeListener('close', onClose);
    process.removeListener('SIGINT', onSigint);
    if (ownRl) rl.close();
    return { outcome, resolved: [...resolved.values()], tokenCost };
  };

  const record = (
    d: GrillingDecision,
    answer: string,
    tag: ProvenanceTag,
    citation?: string,
  ): void => {
    const entry: ResolvedDecision = {
      id: d.id,
      text: d.text,
      blast_radius: d.blast_radius,
      answer,
      tag,
    };
    if (citation) entry.citation = citation;
    resolved.set(d.id, entry);
  };

  let round = 0;
  let questionsAsked = 0;

  while (!cancelled) {
    const frontier = decisions
      .filter((d) => !resolved.has(d.id) && d.prerequisites.every((p) => resolved.has(p)))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (frontier.length === 0) break; // every reachable decision is settled
    if (round >= MAX_ROUNDS || questionsAsked >= MAX_QUESTIONS) break; // cap → defaults below

    round += 1;
    for (const d of frontier) {
      if (cancelled) return finish('cancelled');
      if (questionsAsked >= MAX_QUESTIONS) break;
      questionsAsked += 1;

      // Fact-check lookup-able decisions before displaying — the result pre-fills
      // the suggestion; its tag is applied only if the operator accepts it.
      const fc = d.is_lookup_able
        ? await factCheck(d.text, opts.repoRoot, trackingLlm, opts.model)
        : undefined;
      if (cancelled) return finish('cancelled');
      // Only a *cited* fact-check is grounded enough to trust. An uncited result
      // (no citation found, or the lookup errored and factCheck returned its
      // error text as `answer`) must never become the suggested/recorded answer —
      // otherwise an infra error string would silently cascade into the brief the
      // planner consumes, the exact failure this gate exists to prevent. Fall back
      // to the human recommendation and surface the inconclusive lookup.
      const grounded = fc && fc.tag === 'fact-cited' ? fc : undefined;
      const suggested = grounded ? grounded.answer : d.recommendation;

      let notice =
        fc && grounded === undefined
          ? 'Repo lookup was inconclusive (no citation); showing the recommendation.'
          : '';
      let reprompts = 0;
      for (;;) {
        if (cancelled) return finish('cancelled');
        const raw = await ask(renderPrompt(questionsAsked, d, suggested, notice));
        if (cancelled || raw === null) return finish('cancelled');
        const input = raw.trim();

        if (BULK_ACCEPT.has(input.toLowerCase())) {
          if (d.blast_radius === 'high') {
            notice = 'This decision requires an explicit answer (blast radius: high).';
            if (++reprompts >= MAX_REPROMPTS) break; // leave unresolved → handled at cap
            continue;
          }
          record(d, suggested, grounded ? grounded.tag : 'user-accepted-recommendation', grounded?.citation);
          break;
        }
        // Explicit answer. Matching the suggestion counts as accepting it.
        if (input === suggested) {
          record(d, suggested, grounded ? grounded.tag : 'user-accepted-recommendation', grounded?.citation);
        } else {
          record(d, input, 'user-decided');
        }
        break;
      }
    }
  }

  if (cancelled) return finish('cancelled');

  // Cap reached (or a high-blast reprompt bound) with decisions still open:
  // auto-default the low-blast ones; any unresolved high-blast cancels the run.
  const unresolved = decisions.filter((d) => !resolved.has(d.id));
  for (const d of unresolved) {
    if (d.blast_radius === 'low') record(d, d.recommendation, 'auto-default');
  }
  const highBlastUnresolved = unresolved.some((d) => d.blast_radius === 'high');
  return finish(highBlastUnresolved ? 'cancelled' : 'completed');
}

function renderPrompt(
  n: number,
  d: GrillingDecision,
  suggested: string,
  notice: string,
): string {
  const lines: string[] = [];
  if (notice) lines.push(`  ⚠ ${notice}`);
  lines.push(`\n❓ Q${n} [${d.blast_radius}] ${d.text}`);
  lines.push(`   ➡ recommended: ${suggested}`);
  for (const alt of d.alternatives) {
    lines.push(`   • ${alt.label} — ${alt.tradeoff}`);
  }
  const hint =
    d.blast_radius === 'high'
      ? 'type an explicit answer'
      : "enter/'y' to accept, or type an answer";
  lines.push(`   (${hint}): `);
  return lines.join('\n');
}
