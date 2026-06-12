# Web read-only, or full parity? — A UX recommendation

🎨 *Sally, UX Designer — translating the question into the operator's
actual day.*

**The question on the table:** should `loom web` be reduced to a read-only
visibility surface (status + planning artifacts in the browser, every
mutation only through MCP), or should it keep current parity (status +
approve / reject / stop / kill in both)?

**Short answer:** keep mutation in the web. Don't fight the operator's
context. Add discoverability cues so the web *signals* what wants action.
The MCP-first positioning is about how an operator *starts a conversation*
with loom — it doesn't follow that they should *finish every conversation*
in the same surface.

---

## Whose day are we designing for

Three users, three workflows. None of them is wrong. The design has to
serve all three without privileging one.

### Maya — the IDE-anchored builder

Maya lives in Claude Code. She types "loom, refine this brief into a
proper one and plan an epic" and the conversation handles the whole
loop. She rarely opens the browser. The MCP-first framing was written
for her.

For Maya, the web is a **secondary surface** — she only opens it when
something doesn't fit in the chat: live worker output during a long
story, the planning artifacts when she wants to skim the whole PRD
without flooding her chat context, or the cross-repo view when she's
juggling work in two projects.

**Maya's mutation needs are satisfied by MCP today.** She approves from
chat, kills from chat. The web's action buttons don't matter to her —
but they don't cost her either, because she ignores them.

### Devon — the dashboard-anchored supervisor

Devon launched a long bench run before lunch. When he comes back he opens
`loom web` and watches the cross-repo dashboard. He sees one worker spinning
in a wrong direction — three commits, all backing each other out. He wants
to stop that worker *now*, look at what it did, and re-dispatch with
guidance.

If the web is read-only, Devon's path is: read the story id off the
dashboard → switch to Claude → type "loom, stop story-001-003" → wait
for Claude to call `loom_stop_agent` → see the result → switch back to
the dashboard to confirm. **Five context switches and ~10 seconds of
latency** for what should be a single click.

If the web has the kill button, Devon clicks it. The worker stops.
He never left the surface where he saw the problem.

**Devon is the operator the read-only proposal hurts most.** And Devon
is the operator who would matter most once loom becomes a team product:
his supervisory pattern is what scales to two engineers, then five.

### Priya — the day-one engineer

Priya just ran `loom init` and her first `loom epic`. She has Claude
Code open because the README told her to. She also has a browser tab
because `loom web` printed a URL and she clicked it. The plan finishes.
She sees it in both places.

The risk for Priya in the **current** design is *not* "where do I act"
— it's "did I already approve this in the other window?" Cooper would
call this a violated mental model: the same action available in two
places creates anxiety about state.

The risk for Priya in the **read-only** design is worse: the plan is
sitting there visibly approved-able in the browser, with no button.
She doesn't know to switch to chat. She emails me asking why loom
isn't dispatching. We lose her on day one.

---

## What the failure modes actually look like

The argument for read-only is the failure mode "the web sat showing a
planned epic for 20 minutes because the operator forgot they had to
approve via MCP." Let me steelman both designs by walking the failure
modes.

### Failure modes of read-only

| Mode | Cost |
|---|---|
| Operator opens web first, doesn't realize approval lives elsewhere | Plan sits idle; operator loses trust in the loop |
| Operator sees stuck worker but has to leave surface to stop it | Stop happens late; worker may already have made bad commits |
| MCP server down (claude not running) — no actions available at all | Operator can't even kill a worker |
| Cross-repo dashboard shows 3 plans across 2 projects — operator must remember 3 separate `loom_approve_plan` calls | Cognitive overhead; missed approvals |

### Failure modes of parity (current)

| Mode | Cost |
|---|---|
| Action available in both surfaces — operator unsure where they approved | Mostly imagined: the audit log + the next status poll resolves this |
| The web button gets out of sync with the policy (e.g. requires confirmation that the MCP path doesn't) | Real but cheap to fix; the policy enforcement is structural, the buttons are surface |
| Operator clicks Approve in web, then says "approve" in chat — double-action | The handler is idempotent already (409 if epic is already approved) |
| Web's MCP-equivalent actions hide MCP's discoverability — operators don't learn the tool names | Real for day-one users; solved by surfacing MCP names in the web's empty/help states |

**The parity failure modes are recoverable. The read-only failure modes
include "we lose Priya."** That asymmetry is enough.

---

## The principle I'm applying

Don Norman calls it *action at the point of observation*: when a user
sees a state they want to change, the affordance to change it should be
visible at the same place. Putting the kill button in the dashboard
where Devon sees the stuck worker isn't a coincidence — it's the
correct location for that affordance.

The MCP-first positioning isn't violated by this. MCP is where
*conversations about engineering* live: brief refinement, planning,
mid-flight guidance, asking "what's going on." Those are
text-shaped, ambiguous, dialogue-shaped actions. Approve / reject /
stop / kill are *direct manipulations* — single decisions on a visible
object. Different action register, different surface.

A useful taxonomy:

| Action type | Best surface | Why |
|---|---|---|
| Brief refinement | MCP (chat) | Multi-turn, requires dialogue |
| Plan epic | MCP (chat) — or CLI for scripted runs | Conversational input |
| Approve / reject plan | **Both** | Single decision on a visible object; user might be in either surface |
| Stop run / kill worker | **Both** | Same — direct manipulation |
| Guide agent mid-flight | MCP (chat) | Free-form text — the chat is the input |
| Read planning artifacts | **Both** | The web renders them beautifully; MCP returns structured |
| Cost report | **Both** | Same |
| Status / live worker output | Web (visual), MCP (programmatic) | Different audiences need different shapes |

---

## What I'd actually ship

Keep the web's current mutation parity. Layer on three small
discoverability fixes so the *signal* in the web reflects what wants
action:

1. **Awaiting-approval banner on planned epics.** Already exists as the
   `.approval-banner` class. Today it appears inside the planning-artifacts
   panel. Promote it to the list view too: planned epics should have a
   subtle pulsing chip that says "Awaiting approval" (not just the badge
   color). Priya doesn't miss it; Devon scans it at a glance.

2. **MCP-call equivalents in the action buttons' tooltips.** Hover over
   "Approve & dispatch" → "Or call `loom_approve_plan` from your MCP
   client." Hover over "kill" → "Or call `loom_stop_agent` from your
   MCP client." Day-one engineers learn the MCP tool names without us
   shoving them in their face.

3. **Empty-state copy in the web frames MCP as the entry point.**
   When no epics exist, instead of "No epics planned yet. Run `loom epic
   '...'` to start." make it: *"No epics planned yet. Start one from your
   MCP client (`loom_start_epic`) or run `loom epic '...'` from the
   shell."* The web *recommends* MCP, even as it offers parity.

4. **Audit-log attribution that survives.** The existing audit log
   records `loom_run_via_web`-style actions —
   keep that pattern for every mutation: `epic_approved_via_web`
   vs `epic_approved_via_mcp` vs `epic_approved_via_cli`. The provenance
   matters when an incident asks "who approved that, from where, when?"

Total change: ~30 lines of HTML/CSS + a small audit-log attribution
constant. The architecture stays the same.

---

## What I'd *not* do

- **Don't put guide-agent into the web.** Guide is a long-form text
  input — it belongs in a conversation, not behind a button. If the web
  ever has a guide field, it'll be a sad cousin of the MCP tool. Resist
  the temptation.

- **Don't add a "use MCP for everything" splash screen on launch.** The
  positioning is in the README, getting-started, and the empty-state
  copy. A modal would condescend.

- **Don't enforce a "preferred surface" per action via policy.** That's
  rule-making for a problem operators don't have. The audit log captures
  what happened; the policy gates *what's allowed*, not *what's
  ergonomic*.

---

## The one-sentence recommendation

**Keep mutation parity in the web; surface MCP names where the user can
learn them naturally; let the operator choose the surface that fits the
moment.** The MCP-first positioning is satisfied by where conversations
start, not by where every click happens.

— Sally 🎨
