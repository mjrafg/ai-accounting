## graphify

This project has a code knowledge graph built with graphify (AST-only, no LLM cost).

On this Linux server graphify is installed for the `aiaccounting` service user at:

    /home/aiaccounting/.venvs/graphify/bin/graphify

Autopilot V2 owns graph generation and storage. Graphs are cached per source SHA under
`/srv/ai-accounting/state-v2/graphify/<sourceSha>/graph.json` with a `meta.json` recording
sourceSha, generatedAt, graphifyVersion and node/edge counts. There is no `graphify-out/`
directory in the repository, and tasks must not create one.

Rules:
- Graphify is NAVIGATION and BLAST-RADIUS context only. It is never evidence.
  Evidence order: runtime/database > deterministic tests > current source > graphify > opinion.
- Never raise a material finding justified only by graphify. Confirm it in current source first.
- Query a SHA-pinned graph explicitly, e.g.
  `/home/aiaccounting/.venvs/graphify/bin/graphify affected "<File.ts>" --graph <graph.json> --depth 2`
  `/home/aiaccounting/.venvs/graphify/bin/graphify query "<question>" --graph <graph.json> --budget 1200`
- A graph whose sourceSha differs from the code you are analyzing is STALE: do not trust it.
- Do NOT run `graphify update` from inside a task worktree; V2 rebuilds graphs centrally.
- Graphify models structural edges only (imports/calls/contains/references/inherits).
  It does NOT model event coupling (@OnEvent / emit / queue processors); V2 has a separate
  deterministic event-coupling index for that.

Note for review/investigation agents: Autopilot V2 supplies any needed graph context
directly in your prompt, already pinned to the SHA under analysis. Do not read the
graphify skill documentation and do not run graphify yourself during a review —
spend your tool budget on the actual source, tests and config instead.
