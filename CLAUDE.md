# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Dev (concurrent Vite + tsx watch server)
npm run dev            # both
npm run dev:server     # tsx watch server/index.ts
npm run dev:client     # vite

# Build
npm run build          # build:client (vite) + build:server (tsc -p tsconfig.server.json)
npm start              # node dist/server/server/index.js  (note nested server/server path)

# Production process management (all 4 services)
pm2 start ecosystem.config.cjs
pm2 restart command-center   # restart only orchestrator
pm2 logs agent-coding        # per-agent logs

# MCP server (Phase 5B / 031) — thin stdio shim over the HTTP API.
# Register in Claude Desktop / Code by pointing at dist/server/mcp/index.js.
npm run mcp                  # run from built output (requires command-center HTTP on :3142)
```

No test runner or linter is configured in `package.json` — don't invent one.

**Default ports:** orchestrator `3142`, research/Soundwave `3143`, coding/Ravage `3144`, content `3145`. Matthew browses from a Surface tablet, so always reference `http://10.0.0.46:3142`, never `localhost`.

## Architecture

CMD is a mission orchestrator that routes tasks to tiered agents. The big picture requires understanding four coordinated pieces:

**1. Mission lifecycle (server/)**
`routes.ts` → `orchestrator.ts` receives a mission, classifies intent, scores agents by skill + capability match, and returns a routing decision. On approval, `planner.ts` (Sonnet) decomposes the mission into ordered subtasks with a dependency DAG. `worker-manager.ts` schedules subtasks across a parallel worker pool (8 default / 12 burst), respecting dependencies and isolating coding subtasks in git worktrees (sequential merge with an ephemeral conflict-resolution agent). `judge.ts` runs two-layer evaluation: algorithmic pre-checks then Sonnet scoring on correctness/completeness/relevance, weighted per task type. `scheduler.ts` re-enqueues recurring missions on configurable intervals.

**2. Agent tiers**
- **Tier 1 (Named)** — persistent A2A services in `agents/{research,coding,content}/`, each with `AGENT.md` (system prompt) + `agent.config.json` (tier, tools, MCP, maxTurns, canSpawnSubAgents). Dispatched over A2A protocol.
- **Tier 2 (Custom)** — user-defined markdown prompts stored in SQLite, dispatched via headless Claude Code spawn.
- **Tier 3 (Stock)** — templates pulled from external repos by `stock-loader.ts`, also Claude Code spawn.
- **Tier 4 (ClaudeClaw)** — planned.

**3. Shared A2A runtime (agents/runtime/)**
Every Named agent is a thin wrapper that mounts the shared runtime: a standards-compliant A2A server (`/.well-known/agent.json`, `/task`, `/task/:id`, `/capabilities`, `/health`), a task store state machine (queued → running → completed/failed), and a Claude Code executor that dynamically constructs `--allowedTools`, `--mcp-config`, and `--strict-mcp-config` from the per-agent `agent.config.json`. `--strict-mcp-config` isolation prevents leaking Matthew's personal MCP servers into agent sessions.

**4. Capability registry (server/db.ts)**
SQLite cache of agent capabilities, synced from `agent.config.json` files on startup. Source of truth lives in the config files — editing the DB directly will be overwritten. Add a new Named agent by: creating `agents/<name>/`, registering in `ecosystem.config.cjs` AND `server/seed.ts`, then restarting pm2.

## Conventions specific to this repo

- TypeScript ESM with `"type": "module"` — imports of local `.ts` source must use `.js` extensions (NodeNext resolution).
- `shared/` holds the A2A protocol types and cross-cutting types (`types.ts`). Both server and agents import from here.
- Routing weights are dimensional and per-task-type (coding: 60% correctness, research: 50% completeness, content: 50% relevance). Don't collapse them into a single score.
- HIL gate: missions go propose → approve → execute. Never auto-approve in orchestrator flow.
- The pm2 built `start` script points at `dist/server/server/index.js` (tsc emits a nested `server/` inside `dist/server/`). Don't "fix" this path without updating tsconfig.

## Integration points

- **DataTG / ClaudeClaw Telegram** — `/cmd` in Telegram hits this server via the `COMMAND_CENTER_URL` env var.
- **`/api/chat`** — lightweight Q&A endpoint that does NOT spawn an agent; fast path for status questions.
- **Stock agent repos** — cloned into `store/` by `stock-loader.ts`; `POST /api/stock-agents/sync` refreshes them.
