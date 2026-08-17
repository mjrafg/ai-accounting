# Autopilot V2 — Production-Readiness Validation

This records what was validated in the Autopilot V2 control plane before it was trusted to run tasks end to end. Every statement below reflects the implementation in `tools/autopilot-v2/` and the host layout under `/srv/ai-accounting/`.

## Control plane

- V2 is a dependency-free `node:http` server (`tools/autopilot-v2/server.ts`) serving a small JSON API plus an SSE stream, bound to `AI_BIND_HOST`:`AI_V2_PORT` (default `172.17.0.1:8788`) rather than a public interface.
- Access is a session cookie, with TOTP (RFC 6238) MFA required on sensitive approvals — merge, deploy, human decisions — once enrolled; per-endpoint rate limits cover login, MFA, writes, merge and deploy.
- The API exposes a fixed verb set with no shell passthrough, and agent output is redacted before it reaches the stream log, the per-agent transcripts or the wire — the one exception being the raw debug artifacts described below, which stay `0600` on disk and are never served.
- Billing is `SUBSCRIPTION_CLI_ONLY`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from agent child environments, and a task escalates if paid keys are present.

## Isolation model

- Three separate places. The control-plane repo/branch runs the orchestrator; each task gets its own git worktree under `/srv/ai-accounting/worktrees/<TASK-ID>` cut from `TASK_BASE_SHA` (the approved `origin/main`); all task state lives in `/srv/ai-accounting/state-v2`, outside every worktree.
- Because a task branch starts at the approved base and never at control-plane HEAD, control-plane commits cannot appear in a task diff.
- Provisioning artifacts stay out of diffs too: `node_modules` is symlinked and the test `.env` copied, with both listed in the per-worktree `info/exclude`.
- Git hooks are disabled per worktree via `core.hooksPath`, so no run needs `--no-verify`.

## Live streaming pipeline

- Agent CLIs emit JSONL (`claude` with `--output-format stream-json --include-partial-messages`, `codex exec --json`). Each chunk is redacted the moment it arrives.
- The redacted chunk is appended to a durable per-task stream log with a monotonic id assigned exactly once at append time, and fanned out to a per-agent transcript.
- SSE serves from that log: live appends are broadcast, and a reconnect carrying `Last-Event-ID` replays from disk after the cursor, so history and live continue without duplicates.
- Raw provider envelopes are kept as `0600` debug artifacts and are never served.
- `events.jsonl` is append-only and content-hashed (`EV2-<16hex>`); `task.json` is a derived projection rebuildable from it, never a second authority.

## Gates a task passes

- DESIGN produces a scoped design revision with predictions and acceptance criteria, then IMPLEMENT applies it inside the task worktree.
- VERIFY is the fast gate: scope allowlist and protected-path policy, typecheck, and the targeted affected specs (plus stage0 for high risk).
- REVIEW runs a risk-budgeted, bounded fix/re-review loop; CRITICAL findings block, and a blocker count that stops decreasing goes to a human decision instead of an endless debate.
- FINAL_ACCEPTANCE executes the design's prediction checks; medium adds stage0; high adds stage0 plus Stage -1 under a global lock together with per-document and cache/ledger reconciliation, and failure-signature drift is routed to a human decision rather than auto-rebaselined.
- Auto-merge requires green gates, no unresolved CRITICAL findings, no evidence conflict and no human trigger, and merges only the reviewed SHA. Auto-deploy additionally requires a verified backup and a recorded rollback SHA.
