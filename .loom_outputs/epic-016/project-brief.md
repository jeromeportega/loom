# Loom Dogfooding Cleanup: Trustworthy Overlap Advisory & Dead MCP-Server Residue Removal

## The Problem

Dogfooding loom surfaced three pieces of dead or misleading residue that erode operator trust in the tooling:

1. **The cross-epic overlap advisory cries wolf.** At approve time, loom warns when two epics claim the same file. But the detector scrapes plain words and code fragments out of planning *prose* and treats them as file paths. The result is an advisory full of items that are not paths at all. Noise this dense trains operators to ignore the advisory entirely — defeating its purpose precisely when a *genuine* overlap appears.

2. **Dead loom-self-server plumbing lingers after MCP removal.** The loom MCP server was removed, but its scaffolding survived: worker-config materialization still carries an optional `loom-server` entry parameter, and the supervisor still has a branch that would feed it for the cursor backend. Nothing constructs that entry anymore, so the path is dead code. Worse, comments still describe the cursor backend as receiving the loom server — a statement that is now false and actively misleading to anyone reading the code.

3. **The testing runbook documents a removed feature as if current.** A section still describes how the old MCP server epic was tested, including the now-removed `serve` command, with no marker that this is historical. A reader can mistake it for current behavior.

## Target Users

- **Primary — loom operators.** People who run `loom approve` and rely on the overlap advisory to catch real conflicts before releasing epics for execution. They are the ones currently being trained to distrust the advisory.
- **Secondary — loom maintainers / contributors.** People reading the supervisor and worker-config code or the testing runbook, who are misled by dead branches and stale comments about a server that no longer exists.
- **Anti-persona — none of consequence.** This is internal cleanup; there is no external/end-user surface to protect beyond keeping the advisory advisory-only.

## Proposed Solution

A scoped, three-part cleanup that makes the overlap advisory trustworthy, deletes the orphaned loom-self-server code path and its misleading comments, and corrects the historical doc — all without touching the retained third-party worker MCP provisioning.

## Key Capabilities

1. **Path-aware overlap detection.** The detector treats a token as a candidate file only when it looks like a real path — it contains a path separator or a known source-file extension — and, ideally, corresponds to a file that actually exists under the project.
2. **Declared-ownership as the preferred source.** Where stories declare file ownership, derive each epic's claimed-files set from that declaration rather than from free text. Free-text scraping becomes the fallback, not the default. `[ASSUMPTION]` Story schemas already carry a declared file-ownership field; if not, the fallback path must still meet the path-validity bar above.
3. **Clean, advisory-only output.** After the fix the advisory lists only plausible shared files — never bare words or code fragments — and still warns on genuinely shared files. It remains advisory-only and does not block approval.
4. **Removal of the loom-self-server materialization path.** Delete the optional `loom-server` entry parameter on worker-config materialization, the supervisor branch that fed it for the cursor backend, and the stale comments describing the cursor backend as receiving the loom server.
5. **Preserved third-party provisioning.** The materialization of operator-approved third-party servers from the policy registry into the worker config is left exactly as is — behavior and tests unchanged.
6. **Corrected testing runbook.** The historical MCP-server-epic section is either removed or clearly marked as a record of a removed feature, so the `serve` command is never mistaken for current behavior.

## Constraints

- **Do not change or weaken** the retained third-party worker MCP provisioning, including materialization of third-party servers into the worker config.
- **Do not reintroduce** the loom MCP server in any form.
- **Do not weaken any guardrail.**
- **Keep the overlap advisory advisory-only** — it must still warn, never block, and must still catch genuine shared files.
- Scope is cleanup, not redesign: no new advisory features beyond correctness.

## Risks and Open Questions

- **Over-correction risk.** Tightening path heuristics too far could suppress *genuine* overlaps (false negatives), which is more dangerous than the current false positives. The test must assert both: no false entries from prose *and* a real shared file is still reported.
- **`[ASSUMPTION]` Declared file-ownership availability.** The brief says to prefer story declared file ownership "where that information exists." It is unknown whether all current story formats populate this; the fallback heuristic must hold the line when they do not.
- **`[ASSUMPTION]` File-existence check scope.** "Ideally corresponds to a file that exists" is stated as a preference, not a hard requirement. Open question: should a path-shaped token for a not-yet-created file (legitimate for in-flight epics) be included? Recommend: include path-shaped tokens even if absent, since new epics create new files — existence is a tiebreaker, not a gate. Confirm with maintainers.
- **Hidden consumers of the `loom-server` parameter.** Removing the optional parameter assumes no other caller passes it. The dead-code claim should be verified across the codebase before deletion.
- **Doc decision.** Remove vs. mark-as-historical for the runbook section is left open; marking preserves institutional memory of how the removed feature was tested, removal reduces clutter. `[ASSUMPTION]` Marking is preferable.

## Success Criteria

- [ ] The cross-epic overlap advisory lists only real candidate file paths and **never** bare words or non-path code fragments, verified by a test over a planning input whose prose previously produced false entries.
- [ ] The same (or a companion) test confirms a genuinely shared file is still reported — the advisory has not gone silent.
- [ ] The optional `loom-server` entry parameter on worker-config materialization is removed.
- [ ] The supervisor branch that would have fed the loom-server entry for the cursor backend is removed.
- [ ] All comments describing the cursor backend as receiving the loom server are removed; no code or comment implies loom injects its own server into a worker config.
- [ ] Third-party server provisioning into the worker config is unchanged and its tests still pass green.
- [ ] The testing runbook no longer presents the removed MCP `serve` command as current behavior — either deleted or clearly marked historical.
- [ ] The full build and test suite pass.
