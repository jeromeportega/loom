---
name: loom-approve
description: Approve a planned loom epic, releasing it for execution.
---

# /loom-approve

Confirm which epic the user means, then call the
`loom_approve_plan` MCP tool (or run `loom approve <epic-id>`). Approve only
releases the epic for execution — it does not dispatch workers. Tell the user
to run `loom run <epic-id>` to dispatch the story agents.
