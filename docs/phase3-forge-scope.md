# Phase 3 — Sky-Lynx Recommends × Custom-Forge Scope

**Status:** Design doc, not yet implemented
**Owner:** CMD orchestrator + `store/custom-agents/custom-forge.md`
**Depends on:** Phase 1 (shipped 2026-04-14, `server/routes.ts:702-772`, `src/pages/SkyLynx.tsx`)
**Blocked by:** Phase 2 (Soundwave research augmentation) — not blocking; Phase 3 can ship independently

---

## 1. Goal statement

Phase 3 closes the Sky-Lynx → skill-library feedback loop. Sky-Lynx already produces free-form JSON recommendations about the system (skills to deprecate, routing weights to adjust, preference caps to tighten). Today those recs are read-only text in the CMD UI — a human has to read them, decide, and hand-edit skills or routing config. Phase 3 wires the `custom-forge` agent in as the automated consumer: Forge receives a vetted Sky-Lynx rec, runs its existing pipeline (INGEST → EXTRACT → DRAFT → PR → NOTIFY), and lands a draft PR against the `m2ai-skills-pack` repo (or a local skill edit) with the proposed change and source attribution.

**Success in one sentence:** One Sky-Lynx `target_system: skill` rec flows end-to-end to a reviewable Forge-authored PR within 24 hours of the rec being created, with a human HIL gate before anything merges.

---

## 2. Input — what Sky-Lynx actually produces today

The five files in `/home/apexaipc/projects/sky-lynx/data/claudeclaw-recommendations/` are the full corpus today. Distribution:

| target_system | Count | Files |
|---|---|---|
| `skill`       | 3 | `2026-03-29_070039_skill_0.json`, `2026-04-01_070035_skill_0.json`, `2026-04-16_223719_skill_0.json` |
| `routing`     | 1 | `2026-04-16_223719_routing_1.json` |
| `preference`  | 1 | `2026-04-16_223719_preference_2.json` |

### Field-by-field reality check (based on 5 samples)

| Field | Always present | Always useful | Notes |
|---|---|---|---|
| `source` | yes | yes | Always `"sky-lynx"`. Cheap but mandatory for attribution. |
| `created_at` | yes | yes | ISO 8601 UTC. Used for idempotency/dedup. |
| `target_system` | yes | yes | One of `skill`, `routing`, `preference`. Drives Forge branching logic. |
| `title` | yes | mostly | Sometimes leads with a number (`"5. Skill Deprecation..."`) — list-index leakage from the LLM prompt. Cosmetic. |
| `priority` | yes | yes | `low`/`medium`/`high`. Used for queueing + squelch thresholds. |
| `evidence` | yes | yes | Prose. Varies from crisp ("`worker` at 49% success across 75 tasks") to vague ("0% utilization across 28 skills" — which 28? not listed). |
| `suggested_change` | yes | **NO** | **Populated in 4/5, empty string in 1/5** (`2026-04-01_..._skill_0.json`). Forge must handle empty. |
| `impact` | yes | **NO** | Same — empty in 1/5. |
| `reversibility` | yes | yes | `low`/`medium`/`high`. Directly maps to PR risk level. |
| `recommendation_type` | yes | mostly | Values seen: `other`, `framework_refinement`, `constraint_addition`, `constraint_removal`, `pipeline_change`. Taxonomy is not closed — Forge must gracefully degrade on unknown values. |

### Quality gaps Forge must absorb

1. **Empty `suggested_change` / `impact`.** The 2026-04-01 rec has both blank. Forge cannot draft a PR from this alone — must either (a) skip, (b) escalate for human elaboration, or (c) call back to Sky-Lynx to re-generate. v1 should **skip with an explicit "insufficient-rec" log entry**.
2. **Vague evidence with no pointer.** "0% utilization across 28 skills" does not name the skills. Forge's `audit-skills` skill can re-derive the list from usage data, so this is recoverable — but Forge must know to do that step, not trust the rec alone.
3. **Title list-index artifacts** (`"5. Skill Deprecation..."`). Strip leading `^\d+\.\s*` before using the title for PR branch names or commit messages.
4. **No stable ID.** The filename is the only natural key. Dedup must key on `(created_at, target_system, title)` — two recs with the same tuple are the same rec.

---

## 3. Data contract

The minimum viable schema Forge consumes. Everything else in the JSON is ignored for v1.

```ts
interface ForgeInputRec {
  // Identity (required — used for dedup, attribution, branch naming)
  filename: string;           // e.g. "2026-04-16_223719_skill_0.json"
  created_at: string;         // ISO 8601
  source: string;             // expect "sky-lynx"; reject other values in v1

  // Routing (required — determines which Forge workflow runs)
  target_system: "skill" | "routing" | "preference";
  recommendation_type: string; // free text; Forge branches by regex

  // Content (required — Forge rejects if suggested_change is empty)
  title: string;
  priority: "low" | "medium" | "high";
  evidence: string;
  suggested_change: string;   // REQUIRED non-empty for v1

  // Metadata (optional but used for PR labelling)
  impact?: string;
  reversibility?: "low" | "medium" | "high";
}
```

**Validation rules (v1):**
- Reject if `source !== "sky-lynx"`.
- Reject if `target_system` is not `skill` (see §5 for why routing/preference are deferred).
- Reject if `suggested_change` is empty or whitespace.
- Reject if `priority === "low"` **unless operator explicitly dispatched it** (see §4). Why: low-priority skill deprecations shouldn't auto-PR.

All rejections produce a log row in `data/forge-dispatch-log.db` (new, see §6). Nothing silent.

---

## 4. Trigger mechanism

Three candidates:

| Option | Description | Pros | Cons |
|---|---|---|---|
| (a) **CMD event** | Fire on "new sky-lynx rec" event | Real-time, consistent with 026 dispatch model | No such event source exists today; Sky-Lynx writes files outside CMD's watch path. Building a filesystem watcher or polling adapter is ~4 hours of infra before the *actual* feature starts. |
| (b) **Scheduled cron** | Forge checks for new recs every N hours | Cheap, leverages existing `scheduler.ts` | Latency (up to N hours). Still need dedup against already-processed recs. |
| (c) **Manual dispatch** | Operator clicks "Send to Forge" in UI | Human-in-the-loop by default, matches HIL gate in `CLAUDE.md:55`. Forces operator to read the rec first — which kills option-(a) race conditions where Forge PRs a garbage rec. | Requires UI work on `src/pages/SkyLynx.tsx` and one new endpoint. |

### v1 choice: **(c) Manual dispatch**

**Why:** The 5 recs in hand today show a 1-in-5 rate of blank `suggested_change` and at least one case of vague evidence. Auto-dispatching from a cron would flood Forge with noise, and `CLAUDE.md:55` states missions go propose → approve → execute — skipping the approve step for this loop violates the HIL gate that already exists. Manual dispatch is also the cheapest path to a working end-to-end demo, and it builds the signal we'd need to later justify (a) or (b).

**What v2 (§10) does:** upgrade to (b) scheduled cron, with the signal we collect from v1 manual runs used to auto-skip low-quality recs.

---

## 5. Forge workflow per rec type

### 5.1 `target_system: skill`

**In scope for v1.** Two sub-flows driven by `recommendation_type`:

- **`constraint_removal`** (e.g. the 2026-04-16 rec "Execute 14-day gate cleanup on 43 unused skills")
  - Forge runs `audit-skills` to enumerate candidates from its own view of the skills dir.
  - Cross-checks against active agent manifests + callsite sponsorship (the rule in `~/.claude/CLAUDE.md`).
  - For each skill with zero sponsorship: Forge drafts a deletion PR against `m2ai-skills-pack` (removes directory + updates README entry).
  - **Limit: max 3 deletions per dispatch** (per Forge's existing "Max 3 skills per run" rule in `custom-forge.md:22`).
  - PR description includes the Sky-Lynx rec filename, evidence text, and a list of skills being deleted with their sponsorship-check result.

- **`framework_refinement` / `other` / unknown** (e.g. 2026-03-29 "Skill Deprecation and Consolidation", 2026-04-01 "Audit Unused Skills")
  - If `suggested_change` is empty → reject (see §3).
  - Otherwise: Forge runs `extract-technique` on the `suggested_change` + `evidence` text to structure the change, then `draft-skill` to either (a) update an existing SKILL.md or (b) draft a new consolidated skill. PR against `m2ai-skills-pack`.

**Worked example using the real 2026-04-16 rec:**
> *Title:* "Execute 14-day gate cleanup on 43 unused skills"
> *recommendation_type:* `constraint_removal`
> *Forge action:* audit-skills → identify skills with zero grep-sponsorship → draft PR deleting top 3 candidates by priority (ignoring `get-api-docs` per the rec's own flag) → PR title "chore(skills): delete N unsponsored skills per Sky-Lynx 2026-04-16" → body cites the rec file and lists each skill with its sponsorship-check output.

### 5.2 `target_system: routing`

**OUT OF SCOPE for v1.** Why: the 2026-04-16 routing rec says "temporarily lower `worker`'s weight for coding tasks" — that's not a skill change, it's a `server/orchestrator.ts` routing-weight edit. Forge's manifest (`custom-forge.md:4`) lists only skill-related skills. Making Forge edit orchestrator config would expand its scope beyond its stated role and risk routing regressions.

**What v2+ does:** A separate dispatcher (or a new Tier-2 agent, "Rewire") handles routing recs. Out of scope for Phase 3.

### 5.3 `target_system: preference`

**OUT OF SCOPE for v1.** Why: preferences live in a different system (the preference store, not the skill library). The 2026-04-16 preference rec ("Cap preference auto-learning until confidence stabilizes") would require Forge to edit preference-store config or the LLM-discovery daemon — again, outside its manifest.

**What v2+ does:** either extend Forge's manifest or build a separate agent. Deferred.

---

## 6. Output surface

Three candidate landing spots:

| Landing | Fits what | v1? |
|---|---|---|
| Local `~/.claude/skills/<name>/SKILL.md` edits | Personal skill library, no review | **No** — violates HIL gate |
| PR to `m2ai-skills-pack` GitHub repo | Already has a sharing pipeline (see `/publish-skill` skill + `~/.claude/CLAUDE.md` section on skill publishing) | **Yes** |
| New "Forge drafts" tab in CMD | Observation only; doesn't land the change | Partial — see UI impact §8 |

### v1 choice: **PR to `m2ai-skills-pack`** as the landing, with a **"Forge drafts" section added to the existing Sky-Lynx page** (not a new tab) so the operator can see which recs Forge already acted on.

**Why:** The skill-publishing flow is already documented (`~/.claude/CLAUDE.md` "Skill Publishing" section) and uses `gh` CLI + the pack repo. Piggybacking on that avoids inventing a new output surface. The on-page Forge-draft list keeps the feedback visible without a second tab.

**v1 requires:**
- `gh` CLI auth already works for `m2ai-portfolio` (per `CLAUDE.md` GitHub orgs table) — no new auth.
- A new SQLite table `forge_dispatches` (columns: `id`, `rec_filename`, `dispatched_at`, `pr_url`, `status`, `error`) in `~/projects/command-center/data/cmd.db` or a separate `forge-dispatch-log.db`. v1 uses a new separate file to avoid touching the main schema.
- Forge's existing `draft-skill` skill must be verified to target `m2ai-skills-pack` and not the personal `~/.claude/skills/` dir. Assumption: today it drafts to the personal dir. Open question in §9.

---

## 7. Integration with existing Forge pipeline

Forge's current pipeline from `custom-forge.md:18`: **INGEST → EXTRACT → DRAFT → PR → NOTIFY**.

### Decision: **enter at INGEST, skip EXTRACT when `suggested_change` is substantive**

- **INGEST:** Sky-Lynx rec is just another source, parallel to a YouTube video. Reuse INGEST — but use a new sub-skill `ingest-sky-lynx-rec` (lightweight: parse the JSON, validate against §3 contract, hand off). `check-sources` stays on the YouTube path.
- **EXTRACT:** The current EXTRACT phase (`extract-technique`) is designed for video transcripts. A Sky-Lynx rec's `suggested_change` is already the extracted technique — running EXTRACT over it risks re-summarization drift. **Rule: if `suggested_change.length >= 50 chars`, skip EXTRACT. Otherwise run EXTRACT over `evidence + suggested_change` to fill the gap.**
- **DRAFT:** Runs normally. `draft-skill` for `framework_refinement`; `audit-skills` for `constraint_removal`. This is the main reuse.
- **PR:** Runs normally. PR body gets an auto-generated "Source: Sky-Lynx rec `<filename>`" footer with the `evidence` and `impact` quoted verbatim.
- **NOTIFY:** Runs normally. Adds a row to `forge_dispatches` so CMD UI can surface it (§8).

**Why skip EXTRACT conditionally:** Sky-Lynx is already an LLM-structured output. Running another LLM summarization over an LLM summarization is the exact pattern `compensating-complexity-auditor` flags. The 50-char threshold is arbitrary but falsifiable — tune after v1 runs.

---

## 8. UI impact on CMD

### Changes to `src/pages/SkyLynx.tsx`

1. **Add a "Send to Forge" button** to each row in the "Recent Recommendations (free-form)" section (currently `SkyLynx.tsx:190-212`). Disabled (greyed + tooltip) if:
   - `target_system !== "skill"` (v1 scope)
   - `suggested_change` is empty
   - rec already dispatched (check `forge_dispatches` via new endpoint)
2. **Add a "Forge Drafts" panel** below the recommendations list. Reads from `GET /api/forge/dispatches`. Shows: rec filename, dispatched_at, status (pending/succeeded/failed), PR URL if any.

### New API endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/forge/dispatch` | Body: `{ rec_filename: string }`. Loads the rec from `SKYLYNX_RECS_DIR`, validates §3 contract, spawns Forge via the existing custom-agent dispatch path in `server/custom-agents.ts` + `server/orchestrator.ts:696`. Returns `{ dispatch_id, status }`. |
| `GET` | `/api/forge/dispatches` | Returns last 50 rows from `forge_dispatches`. |

### What NOT to do in v1
- Do not make the button auto-fire. Operator clicks. Full stop.
- Do not add a separate Forge tab. The draft list lives on the Sky-Lynx page so the rec and the dispatch outcome stay adjacent.

---

## 9. Open questions requiring operator decision

Only items a non-author needs to decide:

- [ ] **Target repo for Forge PRs.** Default assumption: `m2ai-portfolio/m2ai-skills-pack`. Confirm? Or is there a separate `forge-drafts` branch / repo? This blocks the `draft-skill` target path.
- [ ] **Does Forge's current `draft-skill` write to personal `~/.claude/skills/` or to `m2ai-skills-pack`?** If personal, Phase 3 needs a mode flag. Confirm by reading the actual skill before implementation (out of scope for this doc).
- [ ] **PR approver policy.** Auto-request review from `@MatthewSnow2`? Require a label? v1 assumes draft PR, no auto-merge, review via normal GitHub flow.
- [ ] **Deletion approval bar.** For `constraint_removal` (skill deletion) — is a single human review on the PR enough, or do we require a second signal (e.g. rec must appear twice across weeks)? The 2026-04-16 rec cites a one-shot 91.5% unused figure; a repeat-gate may be prudent.
- [ ] **Rate limit.** Max dispatches per day to prevent a chatty Sky-Lynx from flooding PRs. Default proposal: 3/day (matches Forge's existing "max 3 skills per run" rule, extended to per-day across runs). Confirm.
- [ ] **Phase 1 defect?** `routes.ts:689-700` `SkylynxJsonRec` does not expose `suggested_change`, `impact`, or `reversibility` to the UI client. That's fine for Phase 1's read-only display, but Phase 3 needs these fields surfaced so the operator can preview what Forge will consume before clicking dispatch. Not fixing here — flagging per instructions.

---

## 10. Phased build plan

### v1 — minimum shippable (one full skill rec → draft PR end-to-end) — ~6h

1. Add `forge_dispatches` SQLite table + migration (~30m).
2. Add `POST /api/forge/dispatch` + `GET /api/forge/dispatches` endpoints in `routes.ts` (~2h):
   - Parse rec JSON from `SKYLYNX_RECS_DIR`.
   - Validate against §3 contract (reject early).
   - Spawn Forge via existing custom-agent dispatch path (reuse `server/custom-agents.ts` loader + `spawn('claude', …)` from `orchestrator.ts:696`).
   - Record the dispatch row.
3. Add `ingest-sky-lynx-rec` sub-skill under Forge (small SKILL.md, references the §3 contract) (~1h).
4. Wire conditional-skip of EXTRACT in Forge prompt (~30m, prompt-only edit to `custom-forge.md`).
5. Add UI button + "Forge Drafts" panel to `SkyLynx.tsx` (~2h).
6. Manual smoke test: dispatch the 2026-04-16 `skill_0` rec → verify a draft PR lands on `m2ai-skills-pack`.

**Scope discipline:** v1 handles `target_system: skill` ONLY. No routing. No preference. No auto-trigger.

### v2 — production quality (~6h)

1. Move trigger from manual to **option (b) cron**, running every 6h. Dedup by `(created_at, target_system, title)` against `forge_dispatches`.
2. Add the dedup index + idempotency key.
3. Surface `suggested_change`, `impact`, `reversibility` in the Sky-Lynx UI rec row (fixes the Phase 1 defect noted in §9).
4. Add a "squelch" toggle per `target_system` on the UI so operator can pause auto-dispatch.
5. Add metrics: dispatch success rate, PR-merge rate, days-to-merge — feeds back into Sky-Lynx's own signals.

### v3 — broader coverage (~8h)

1. `target_system: routing` support — either extend Forge's manifest (add a `propose-routing-change` skill) or stand up a new Tier-2 agent "Rewire" that consumes routing recs and drafts PRs to `server/orchestrator.ts`.
2. `target_system: preference` support — similar decision: extend Forge or new agent.
3. Bi-directional: when a Forge PR merges, write an outcome record back so Sky-Lynx can learn which rec shapes are accepted vs rejected (closes the continuous-improvement loop).

---

## 11. Out of scope for this doc

- **Forge's skill quality.** We assume `draft-skill`, `extract-technique`, and `audit-skills` work. Any defects in those are Phase-independent.
- **Sky-Lynx prompt tuning.** The 1-in-5 empty-suggested_change rate is a Sky-Lynx problem, not a Phase 3 problem. Sky-Lynx owns its own quality bar.
- **Structured `proposals.db` integration.** CMD's Phase 1 also reads the structured SQLite proposals from `sky-lynx/data/proposals.db` (see `routes.ts:706`). Those are parameter proposals (different schema, different target). Phase 3 explicitly scopes to the **JSON free-form recs** only. Parameter-proposal automation is Phase 4+.
- **ClaudeClaw Tier-4 dispatch.** The custom-forge agent runs as a Tier-2 headless Claude Code spawn (`CLAUDE.md:40-42`). Upgrading to a persistent A2A service is a separate refactor.
- **Cost tracking.** Each Forge dispatch pays the boot tax (~87k tokens per `feedback_claude_headless_boot_tax.md` in auto-memory). v2 cron must factor this — v1 dispatches are manual so cost is bounded.
- **Authorization / multi-user.** CMD is single-operator today. Phase 3 does not introduce per-user permissions.
- **Rollback of Forge PRs.** If a merged Forge PR causes a regression, rollback is via normal `git revert` — not automated in Phase 3.
