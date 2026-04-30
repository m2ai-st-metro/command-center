<p align="center">
  <img src="docs/cmd-banner.png" alt="CMD — Command Center" width="800" />
</p>

<p align="center">
  <strong>Multi-agent orchestration platform with tiered agent architecture</strong>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &bull;
  <a href="#agent-tiers">Agent Tiers</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#roadmap">Roadmap</a>
</p>

---

CMD (Command Center) is a mission orchestration platform that routes tasks to the right AI agent. Instead of one model doing everything, CMD classifies intent, selects the best-fit agent from a tiered system, dispatches via the A2A protocol, and tracks outcomes — so every agent gets better over time.

## Live Dashboard

<p align="center">
  <img src="docs/cmd-dashboard-overview.png" alt="CMD Dashboard — token usage, mission throughput, agent roster, worker pool, Sky-Lynx recs" width="900" />
</p>

<p align="center">
  <img src="docs/cmd-dashboard-activity.png" alt="CMD Dashboard — agent success mix, upcoming schedules, system status, recent mission activity" width="900" />
</p>

The dashboard is the daily operator surface: live token usage and projection, mission throughput, per-agent success mix, scheduled missions, worker-pool capacity, Sky-Lynx routing recommendations, and a real-time mission activity log.

## Quickstart

### Prerequisites

- Node.js 18+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI installed and authenticated
- Git (for cloning stock agent repos)

### Install

```bash
git clone https://github.com/m2ai-st-metro/command-center.git
cd command-center
npm install
```

### Configure Your Primary Agent

CMD requires a **primary agent** — the orchestrator that routes all missions. The default is `Data`, configured in `server/seed.ts`. Edit this to set your own agent name, skills, and personality.

Your primary agent needs:
- A name and description
- Skill routing keywords (how CMD classifies which agent handles what)
- An optional system prompt for direct Claude Code dispatch

### Build & Run

```bash
# Build frontend + server
npx vite build
npx tsc -p tsconfig.server.json

# Start all services (orchestrator + agents)
pm2 start ecosystem.config.cjs

# Or run the server directly for development
npx tsx server/index.ts
```

CMD runs at `http://localhost:3142` by default. Set `COMMAND_CENTER_PORT` to change.

### Add Named Agents (Optional)

Named agents are persistent A2A services. Each has its own directory under `agents/` with a capability config:

```bash
agents/
├── research/              # Soundwave — web research + analysis
│   ├── AGENT.md           # System prompt
│   ├── agent.config.json  # Capabilities (tools, MCP, limits)
│   ├── .claude/mcp.json   # MCP server config (firecrawl, etc.)
│   └── index.ts           # A2A server entry point
├── coding/                # Ravage — software engineering
│   ├── AGENT.md
│   ├── agent.config.json
│   └── index.ts
├── content/               # Content writing + social media
│   ├── AGENT.md
│   ├── agent.config.json
│   └── index.ts
└── runtime/               # Shared A2A runtime (server, executor, task store)
```

Each `agent.config.json` declares the agent's tier, tools, MCP servers, and limits:

```json
{
  "tier": 1,
  "name": "Soundwave",
  "skills": ["research", "analysis", "web-search"],
  "tools": ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
  "mcpServers": ["firecrawl"],
  "canSpawnSubAgents": false,
  "maxTurns": 30,
  "timeout": 900000
}
```

These configs are the **source of truth** — synced to a capability registry on startup. Register agents in `ecosystem.config.cjs` and `server/seed.ts`, then restart pm2.

### Sync Stock Agents

CMD can discover agent templates from GitHub repos:

```bash
# Via API
curl -X POST http://localhost:3142/api/stock-agents/sync

# Or from the Stock Agents page in the UI
```

By default, it pulls from two repos containing 300+ agent templates across 80+ categories.

## Agent Tiers

<p align="center">
  <img src="docs/cmd-architecture.png" alt="CMD Architecture" width="700" />
</p>

CMD uses a four-tier agent system. Higher tiers have more autonomy and capability.

### Tier 1 — Named Agents

Persistent specialists with their own A2A server, dedicated process, and per-agent capability config. They can be tasked by the orchestrator **or act independently** via cron, direct A2A calls, or manual triggers.

- Own A2A endpoint (dedicated port)
- Own system prompt (`AGENT.md`) + capability config (`agent.config.json`)
- Per-agent tool access (WebSearch, WebFetch, MCP servers via `--allowedTools` + `--mcp-config`)
- `--strict-mcp-config` isolation prevents leaking personal MCP servers
- Can spawn sub-agents (per config — key differentiator for Ravage)
- Persistent — always running
- Learn from past tasks (Sky-Lynx integration planned)
- Can be scheduled for recurring work

**Examples:** Soundwave (research + WebSearch + firecrawl), Ravage (coding + sub-agents), Content Agent (writing)

### Tier 2 — Custom Agents

User-defined agents created through the CMD UI. More capable than stock agents thanks to tailored system prompts, but still ephemeral — spun up for a task, dismissed when done.

- Crafted markdown system prompt
- Created/edited via the Custom Agents page
- Strictly orchestrator-driven (no independent action)
- Improve through prompt refinement

### Tier 3 — Stock Agents

Generic workers loaded from markdown template repositories. The orchestrator spins them up, they execute, they're gone. Like hiring from a staffing agency.

- 300+ templates across 80+ categories
- Browse and load from the Stock Agents page
- Strictly orchestrator-driven
- No memory between tasks

### Tier 4 — ClaudeClaw Agents (Planned)

Framework-coupled agents that run within the ClaudeClaw runtime. These need access to Telegram context, message history, or user sessions that standalone agents can't reach.

### Peers

Autonomous orchestrators that collaborate with CMD as equals, not subordinates. Communication is lateral via A2A with async request/response and priority queuing.

**Example:** Metroplex (autonomous software factory) can request specialist help from CMD, and CMD can monitor and intervene when Metroplex is stuck.

## Features

### Mission Orchestration
- **Capability-aware routing** — Agents scored by skill match + capability match (WebSearch, MCP, sub-agents)
- **Gap detection** — Detects when a task needs capabilities no available agent has, recommends fixes
- **Mission lifecycle** — Propose, plan, approve, execute, judge, log outcomes
- **A2A protocol** — Standard agent-to-agent communication (task submission, polling, status)
- **Multi-path dispatch** — A2A for Named agents, Claude Code spawn for Custom/Stock
- **Busy agent queueing** — Missions re-queued when target agent is occupied
- **Outcome logging** — Track routing quality per agent per task type
- **Scheduled missions** — Recurring missions on configurable intervals (5m, 1h, 24h, 7d)

### Planner-Worker-Judge (Phase 5)

<p align="center">
  <img src="docs/cmd-planner-worker-judge.png" alt="Planner-Worker-Judge Architecture" width="700" />
</p>

- **Mission Planner** — Sonnet decomposes every mission into ordered subtasks with dependency chains
- **Worker Pool** — 8 default / 12 burst parallel worker slots with dependency-aware scheduling
- **Git worktree isolation** — Coding subtasks run in isolated worktrees; sequential merge with ephemeral conflict-resolution agent
- **Quality Judge** — Two-layer evaluation: algorithmic pre-checks (free, instant) + Sonnet LLM scoring on correctness, completeness, and relevance
- **Dimensional routing weights** — Task-type-specific dimension weights (coding: 60% correctness, research: 50% completeness, content: 50% relevance)
- **Retry + failure handling** — Retry once on failure, cancel dependents, continue independents

### Judge-Reasoner Retry Loop (R3.a)
- **Iterative correction** — Failed missions are diagnosed by a Reasoner agent, re-routed, and re-dispatched up to N iterations before escalating
- **Per-iteration agent switching** — Iter N+1 may route to a different agent than iter N; orchestrator releases prior-iter agent on switch
- **Bounded retries** — `JUDGE_MAX_ITERATIONS` caps loop depth; final verdict + finalAction recorded on the mission
- **Sweep release** — On completion or cancellation, every agent pointing at the mission is released (catches intermediate-iteration agents the per-iter switch would miss)

### HiveMind (R3.b)
- **Cross-agent activity log** — Every agent action is appended to a shared activity log other agents can read
- **Read API** — Agents can query recent HiveMind events to coordinate without direct messaging
- **Mission-aware** — Events tagged with mission and iteration so retry loops can see prior attempts

### Embedded MCP + Remote MCP (Phase 5B / 5C)
- **stdio MCP server** — Thin shim over the HTTP API; register `dist/server/mcp/index.js` in Claude Desktop / Code to expose missions, agents, schedules, HiveMind, Sky-Lynx recommendations as tools
- **Remote MCP** — OAuth 2.1 Authorization Code + PKCE; refresh_token grant for silent renewal; works with hosted clients (Cowork, Claude.ai)
- **Sky-Lynx event bridge** — Mission lifecycle events (create / approve / complete / fail / cancel) are sunk into Sky-Lynx for cross-session learning

### Ask Data Chat Advisor
- **Direct Q&A** — `/api/chat` endpoint for quick questions about the system without spawning agents
- **Conversational** — Data answers questions about agents, missions, schedules, and status
- **Zero overhead** — No agent dispatch, no mission lifecycle; fast informational responses

### Command Center UI
- **Chat-style mission input** — Type a goal, see classification + suggested agent inline, approve with one click
- **Mission Detail** — Subtask timeline, judge verdict card (pass/fail + dimensional scores), real-time logs
- **Worker Pool status** — Visual indicator of active/available worker slots on dashboard
- **Named Agents** — Read-only view of Tier 1 agents with capabilities, tools, MCP, tier access matrix
- **Custom Agents** — Full CRUD for user-defined agents with markdown prompts
- **Stock Agents** — Browse 300+ templates by category, search, load into registry
- **Schedules** — Create, pause, resume, delete recurring missions
- **Onboarding** — Example prompts for first-time users

### Agent Runtime
- **Generic A2A server** — Any agent with an `AGENT.md` gets a standards-compliant A2A endpoint
- **Per-agent capabilities** — Dynamic `--allowedTools`, `--mcp-config`, `--strict-mcp-config` from `agent.config.json`
- **Capability registry** — SQLite cache synced from config files on startup
- **Claude Code executor** — Headless Claude Code sessions with dynamic tool/MCP injection
- **Task store** — In-memory task tracking with state machine (queued → running → completed/failed)
- **Progress streaming** — Real-time stderr logging for execution visibility

### Ask Data — Chat Advisor
- **`/api/chat` endpoint** — Lightweight Q&A about the system without spawning agents
- Ask questions about agents, missions, schedules, and system status
- Returns conversational answers from Data (the primary orchestrator persona)
- No agent dispatch overhead — fast, direct responses for informational queries

### Integration
- **DataTG (Galvatron)** — Telegram bot relay for quick tasks and status queries
- **ClaudeClaw/Telegram** — `/cmd` command in Telegram routes queries to CMD via `COMMAND_CENTER_URL` env var
- **Stock repos** — Auto-clone and sync agent templates from GitHub
- **pm2 managed** — All services run as pm2 processes with exponential backoff

## API

All endpoints are under `/api`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/missions` | List all missions |
| `POST` | `/missions` | Create (propose) a mission |
| `GET` | `/missions/:id` | Get mission detail + logs |
| `POST` | `/missions/:id/approve` | Approve and execute |
| `POST` | `/missions/:id/cancel` | Cancel a mission |
| `GET` | `/agents` | List registered agents |
| `GET` | `/status` | Summary for external queries |
| `GET` | `/stats` | Outcome statistics |
| `GET` | `/stock-agents` | List discovered stock agents |
| `POST` | `/stock-agents/sync` | Clone/pull stock repos |
| `POST` | `/stock-agents/load` | Load agent or category into registry |
| `GET` | `/custom-agents` | List custom agents |
| `POST` | `/custom-agents` | Create custom agent |
| `PUT` | `/custom-agents/:id` | Update custom agent |
| `DELETE` | `/custom-agents/:id` | Delete custom agent |
| `GET` | `/agents/capabilities` | List all agent capabilities |
| `GET` | `/agents/:id/capabilities` | Get agent capabilities |
| `GET` | `/schedules` | List scheduled missions |
| `POST` | `/schedules` | Create schedule (goal + interval) |
| `PUT` | `/schedules/:id` | Update schedule (enable/disable/change interval) |
| `DELETE` | `/schedules/:id` | Delete schedule |
| `POST` | `/chat` | Ask Data — lightweight Q&A without agent dispatch |
| `GET` | `/workers` | Worker pool status — active slots, availability, queue |
| `GET` | `/routing/insights` | Routing weights, dimensional quality, gap patterns |

Named agents expose standard A2A endpoints:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/.well-known/agent.json` | Agent card (capabilities, skills) |
| `POST` | `/task` | Submit a task |
| `GET` | `/task/:id` | Poll task status |
| `GET` | `/capabilities` | Agent capabilities config |
| `GET` | `/health` | Health check |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Tailwind CSS, Vite |
| Backend | Express, TypeScript, better-sqlite3 |
| Agent Runtime | Claude Code CLI (headless), A2A protocol |
| Process Manager | pm2 |
| Agent Templates | Markdown with YAML frontmatter |

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1 | Done | DataTG (Galvatron) refactor — strip orchestration from Telegram bot |
| Phase 2 | Done | Command Center MVP — mission dashboard, orchestrator, intent classification |
| Phase 3 | Done | A2A protocol + Research agent (Soundwave) |
| Phase 4 | Done | Coding agent (Ravage) + Content agent + Stock agent loader + bug fixes |
| Phase 4B | Done | Access model, Named Agents page, capability-aware routing, gap detection, schedules, chatbot UI, onboarding |
| Phase 5 | Done | Planner-Worker-Judge — Sonnet mission planner, parallel worker pool (8-12 slots), two-layer quality judge, dimensional routing weights, subtask timeline UI |
| Phase 5B | Done | Embedded MCP server — CMD exposes missions, agents, HiveMind via stdio MCP shim (`dist/server/mcp/index.js`) for Claude Desktop / Code |
| Phase 5C | Done | Remote MCP — OAuth 2.1 Auth Code + PKCE with refresh_token grant for hosted clients (Cowork, Claude.ai) |
| R3.a    | Done | Judge-Reasoner retry loop — iterative diagnosis + re-dispatch with per-iteration agent switching |
| R3.b    | Done | HiveMind — cross-agent activity log + read API for coordination |
| Sky-Lynx bridge | Done | Mission lifecycle events sunk into Sky-Lynx for cross-session learning |
| Phase 6 | **Next** | Peer collaboration — Metroplex A2A integration, async priority queue, health monitoring |
| Phase 7 | Planned | Tier 4 ClaudeClaw agents — framework-coupled agents in ClaudeClaw runtime |

## Project Structure

```
command-center/
├── agents/                 # Named agent definitions + shared runtime
│   ├── coding/             # Ravage — Tier 1 coding specialist
│   ├── content/            # Content — Tier 1 writing specialist
│   ├── research/           # Soundwave — Tier 1 research specialist
│   └── runtime/            # A2A server, executor, task store
├── server/                 # Backend — orchestrator, routes, DB, loaders
│   ├── index.ts            # Express app entry point
│   ├── orchestrator.ts     # Mission lifecycle, capability-aware routing, gap detection
│   ├── planner.ts          # Sonnet mission decomposition into subtasks
│   ├── worker-manager.ts   # Parallel worker pool, subtask scheduling, worktree isolation
│   ├── judge.ts            # Two-layer quality evaluation (algorithmic + LLM)
│   ├── scheduler.ts        # Interval-based mission scheduler
│   ├── routes.ts           # API routes
│   ├── db.ts               # SQLite schema + queries + capability registry + worker pool
│   ├── seed.ts             # Default agent registration
│   ├── stock-loader.ts     # Stock agent discovery from repos
│   └── custom-agents.ts    # Custom agent CRUD
├── src/                    # React frontend
│   ├── pages/              # Dashboard, MissionDetail, NamedAgents, CustomAgents, StockAgents, Schedules
│   ├── components/         # Sidebar
│   └── api.ts              # Fetch wrapper
├── shared/                 # Shared types + A2A protocol
├── store/                  # Runtime data (DB, stock repos, custom agents)
├── docs/                   # Images and documentation
├── ecosystem.config.cjs    # pm2 process config
└── package.json
```

## License

MIT
