# Argus — Implementation Status

**Adaptive Stigmergic Oversight (ASO)** for AI agent swarms: intent-based delegation, stigmergic coordination (shared Git repo), and exception-based human review. Reference implementation for the [ASO paper](docs/aso_main.pdf).

---

## Architecture Overview

| Layer | Component | Status |
|-------|-----------|--------|
| Config | `argus.config.yaml` / `.local`, env (e.g. `CURSOR_API_KEY`, `OPENAI_API_KEY`) | Done |
| Intents | YAML intents (intent + constraints + trustThresholds), `intent list` / `add` | Done |
| Decomposer | Rule-based: 5 work packages, Explorer/Worker/Worker/Worker/Validator; keyword-based sub-tasks (OAuth, API) | MVP |
| Orchestrator | Launch swarm via Cursor API, set run context per agent | Done |
| API | Cursor Cloud Agents: list, get, launch, stop, delete, follow-up | Done |
| Webhook | Embedded server + localtunnel; HMAC-secret validation; 32+ char secret auto-generated | Done |
| Validation | Deterministic checks (summary, status, PR) + optional LLM assessment → confidence + decision (auto_approve / escalate / block) | Done |
| Trust | SQLite store (`.argus/trust.db`), exponential smoothing (α=0.7), per-agent τ | Done |
| Review | Exception store (`.argus/exceptions.json`), approve/reject, follow-up for blocked agents | Done |
| Oversight | Blocked detector: poll RUNNING agents 5+ min with no branch/PR → add to review queue | Done |
| Cleanup | GitHub API: delete `argus/*`, `cursor/*`, `codex/*` branches (paginated), `GITHUB_TOKEN` | Done |
| UI | Dashboard (port 3848 with `run`, 3847 with `ui`): metrics strip, swarm grid, exception queue, activity feed, follow-up | Done |

---

## Data & Storage

- **`.argus/`** — `metrics.json` (run history), `exceptions.json`, `run-context.json`, `trust.db` (SQLite).
- **Config** — `argus.config.local.yaml` (repository, webhookSecret, defaultRef, maxAgents, etc.).
- **Intents** — `intents/*.intent.yaml`.

---

## CLI Surface

- **Run:** `argus run <intent-file>` — decompose, launch 5 agents, start webhook tunnel + dashboard.
- **Intents:** `argus intent list | add <name>`.
- **Review:** `argus review list | approve | reject | show | follow-up <id> <message>`.
- **Infra:** `argus ui`, `argus webhook serve`, `argus agents list`, `argus trust show <id>`, `argus cleanup [--dry-run]`.

---

## Current Limitations

- **Decomposer:** Rule-based only; OAuth and API get predefined sub-tasks; other intents get one task repeated across roles. No LLM-based decomposition or dependency graph.
- **Metrics:** Run metrics and exception rate tracked; throughput/trust/containment computed for dashboard. Coordination cost, adaptation speed, intent fidelity not instrumented (shown as N/A).
- **Single repo:** One configured repository per run; agents filtered by repo for listing.
- **No meta-validator:** Single validation path; no ensemble or meta-validation of validator confidence.

---

## Docs

- [ASO paper](docs/aso_main.pdf) — framework and metrics.
- [Implementation plan](docs/argus-implementation-plan.md) — original design.
- [Dashboard UI plan](docs/dashboard-ui-plan.md) — oversight UI design.
