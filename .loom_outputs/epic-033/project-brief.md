# Route Single-Purpose Analysis Gates Through Non-Agentic Completion Mode

## The Problem

Loom has two distinct classes of LLM call living on one transport. **Agentic personas and workers** (planners, reviewers, coding agents) legitimately need the full `claude-cli` agent harness — tools, working directory, git status, dynamic workspace context. But loom also runs a set of **single-purpose analysis gates** — classifiers, scorers, judges, extractors — that take text in and return a structured verdict. These gates are running on that same agentic harness, and that is both overkill and a correctness hazard:

- The intake classifier, on the agentic path, **executed briefs instead of classifying them** — the harness handed a verdict-only call the ability to act like a coding agent.
- The brief-quality scorer **recently returned a garbage score under load**, the kind of unreliability an agent harness invites for what should be a deterministic completion.

A proven fix already exists in-tree. The LLM request interface has a `nonAgentic` option that the `claude-cli` client honors by **replacing** the system prompt and **disabling tools**. The intake classifier already uses it as the reference pattern. These gates are not getting that treatment yet — so they carry agent risk for no benefit.

## Target Users

- **Primary — loom operators.** They depend on these gates producing correct, reliable verdicts (readiness scores, accept/reject decisions, clustered opportunities) on their own subscription session. They feel every misfire as a bad plan or a wasted run.
- **Secondary — loom maintainers** extending these gates, and the **downstream planner/PM pipeline** that consumes gate verdicts as inputs.
- **Anti-persona — the agentic personas and workers.** The code review agent, PR-description generator, reviewer skills, and the Analyst/PM/Architect/QA planning personas legitimately need the harness. They are explicitly out of scope and must remain untouched.

## Proposed Solution

For each in-scope analysis gate, add the `nonAgentic` option to its existing `llm.complete` call, following the `IntakeClassifier` pattern (`nonAgentic` with `excludeDynamicSections: true`). This converts each gate from a coding agent into a pure completion: system prompt replaced, tools disabled, no dynamic workspace context.

The change stays entirely on the `claude-cli` subscription-session path — non-agentic mode is still a `claude-cli` call, it merely suppresses agent behavior. **No API key, no metered billing.** The goal is correctness and reliability, not a billing change. The `nonAgentic` plumbing itself is already implemented and regression-tested (`LLMClient.ts` request field, `ClaudeCliClient.ts` replace-system-prompt/disable-tools branch) and must not be modified.

## Key Capabilities

Migrate these six gates, lead with the first (highest value, and the one that misfired under load):

1. **Brief-quality scorer / refiner** — `packages/loom-core/src/brief/BriefRefiner.ts`. Returns readiness flag, 0–10 quality score, optional refined brief, critique, and clarification questions. *Lead item; sizeable JSON output — size `max output tokens` accordingly.*
2. **Skill candidate judge** — `packages/loom-core/src/skills/SkillJudge.ts`. Scores a generated skill 0–10 and accepts/rejects.
3. **Lesson extractor** — `packages/loom-core/src/findings/LessonExtractor.ts`. Extracts structured lessons from epic telemetry.
4. **Opportunity clustering** — `packages/loom-core/src/signals/OpportunityEngine.ts`, **including its JSON-repair retry**. Clusters signals into opportunities.
5. **Skill proposal generator** — `packages/loom-core/src/skills/SkillGenerator.ts`. Decides whether story work produced a reusable skill.
6. **Eval-time intake judge** — `packages/loom-core/src/eval/IntakeJudge.ts`. For consistency with the classifier it grades.

**Per-gate, the migration must:** add `nonAgentic` mirroring the classifier; **verify the system prompt is self-contained** (no reliance on working directory, environment, or git status, since non-agentic mode replaces the prompt and excludes dynamic workspace sections); **set an appropriate `max output tokens`** sized to the gate's structured output (several currently rely on defaults); and **preserve existing parsing, retry, and fallback behavior** — only the transport changes.

## Constraints

- **Subscription session only.** Every gate stays on the `claude-cli` path. Not an API-key or billing change.
- **Do not touch the `nonAgentic` plumbing** — it exists and is regression-tested.
- **Do not migrate** `CodeReviewAgent.ts`, `PrDescriptionAgent.ts`, `reviewerSkills.ts`, or the planner personas (Analyst, PM, Architect, QA). Leave unchanged.
- **Preserve each gate's output schema, parsing, and fallback semantics.** Transport-only change.
- **Do not weaken any guardrail.**
- **Reference pattern is fixed:** `IntakeClassifier.ts` (caller), `LLMClient.ts` (`nonAgentic` field), `ClaudeCliClient.ts` (replace-prompt/disable-tools).
- **Testing:** add or update a test per migrated gate asserting the call requests non-agentic mode, mirroring the classifier's regression test.
- **Docs:** update `docs/capabilities.md` if any user-visible behavior changes, and pass the capabilities drift check.

## Risks and Open Questions

- **Self-contained-prompt assumption.** The brief states each gate's prompt "should already hold" as self-contained. `[ASSUMPTION]` If any gate silently leans on dynamic workspace context (cwd, env, git status), replacing the system prompt will degrade or break it in non-obvious ways. *Mitigation: explicitly verify each prompt before migrating — do not take it on faith.*
- **Token-budget truncation.** Under-sizing `max output tokens` truncates structured JSON, causing parse failures that fall through to fallback. The brief scorer's larger payload is the prime risk. *Mitigation: size per gate to expected output.*
- **Causal attribution of the load incident.** `[ASSUMPTION]` The garbage-score-under-load event is attributable to the agentic transport. The migration is justified on overkill/correctness grounds regardless, but we should not claim it definitively resolves that incident without confirmation.
- **Verdict-quality parity.** `[ASSUMPTION]` Removing tools and agent context does not change verdict quality, since these are text-in/verdict-out calls. Worth a sanity check, especially for the eval intake judge (which grades the classifier).
- **Capabilities-doc scope.** `[ASSUMPTION]` No user-visible surface changes, so `docs/capabilities.md` likely needs no content edit beyond passing the drift check — confirm during implementation.

## Success Criteria

- [ ] All six gates issue their `llm.complete` calls in non-agentic mode, following the `IntakeClassifier` pattern.
- [ ] Each migrated gate has an appropriate `max output tokens` and a verified self-contained system prompt.
- [ ] `CodeReviewAgent`, `PrDescriptionAgent`, `reviewerSkills`, and the planner personas remain agentic and unchanged.
- [ ] Each migrated gate has a test asserting it requests non-agentic mode (mirroring the classifier regression test).
- [ ] Each gate's existing output schema, parsing, retry, and fallback behavior is preserved (existing tests still pass).
- [ ] The `nonAgentic` plumbing is untouched.
- [ ] `docs/capabilities.md` is updated if any user-visible behavior changed, and the capabilities drift check passes.
- [ ] The full build and test suite pass.
