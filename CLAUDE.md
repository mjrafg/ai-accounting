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

## How agents reach the graph

Use the V2 wrapper. It is on your PATH and already pinned to the graph built from
exactly the code you are working on:

    graphify-task status
    graphify-task query "<question>"
    graphify-task affected "<File.ts>"
    graphify-task explain "<symbol>"

Do NOT probe with `command -v graphify`, do NOT look for ./graphify-out/, do NOT
invoke the graphify binary directly, and do NOT read the graphify skill
documentation under .claude/skills or .agents/skills. None of those tell you
anything about the real graph here, and reading them only burns your tool budget.
`graphify-task status` is the single source of truth for availability; your prompt
also carries a GRAPHIFY STATUS block generated from the same data.

Graphify is navigation only. Spend the rest of your budget on actual source,
tests and config, and confirm anything the graph suggests in current source
before you rely on it.
