# <img src="assets/argus.png" alt="" style="height: 1em; vertical-align: middle" /> Argus

**Adaptive Stigmergic Oversight (ASO)** for AI Agent Swarms. A reference implementation enabling a single human operator to safely supervise large swarms of AI coding agents via intent-based delegation, stigmergic coordination, and exception-based review.

📄 [Adaptive Stigmergic Oversight: A Scalable Framework for Human Supervision of Large AI Agent Swarms](docs/aso_main.pdf) — the paper this implementation is based on.

## Quick Start

```bash
npm install
npm run build
npm test

# List available intents
npx argus intent list

# Run an intent (requires CURSOR_API_KEY and repository in config)
npx argus run intents/oauth2-auth.intent.yaml
```

## Configuration

1. Copy `argus.config.yaml` to `argus.config.local.yaml`
2. Set `repository` to your GitHub repo URL
3. Set `CURSOR_API_KEY` env var or `apiKeyPath` to a file containing your Cursor API key (from [Cursor Dashboard → Integrations](https://cursor.com/dashboard?tab=integrations))
4. Optional: `OPENAI_API_KEY` env var (or in `.env`) for LLM-based confidence scoring in validation—not in config
5. Optional: `webhookUrl` in config or `-w/--webhook` to use your own webhook (e.g. ngrok). Otherwise `argus run` starts a tunnel automatically.

## Commands

### Run and orchestration
- `argus run <intent-file>` - Decompose intent and launch agent swarm (N=5). Starts a webhook server and tunnel automatically so cloud agents can send status updates; press Ctrl+C to stop. Detects blocked agents (RUNNING 5+ min with no branch/PR) and adds them to the review queue.
- `argus agents list` - List running agents

### Intents
- `argus intent list` - List available intent files
- `argus intent add <name>` - Create new intent from template

### Review (exception-based human oversight)
- `argus review list` - List exceptions pending review
- `argus review approve <id>` - Approve an exception
- `argus review reject <id>` - Reject an exception
- `argus review show <id>` - Show exception details
- `argus review follow-up <id> <message...>` - Send a follow-up prompt to a blocked agent (e.g. unblock with guidance)

### Infrastructure
- `argus webhook serve` - Start webhook server manually (e.g. with ngrok). Not needed for `argus run`—it starts one automatically.
- `argus ui` - Start minimal web UI for monitoring and decisions
- `argus trust show <agent-id>` - Show trust score for an agent
- `argus cleanup` - Delete all `argus/*`, `cursor/*`, and `codex/*` branches from the configured repo (requires `GITHUB_TOKEN`). Use before re-running demos to avoid polluting the repo. `--dry-run` lists branches without deleting.

## Re-running demos

Each `argus run` creates 5 branches and PRs in the target repo (Cursor may name them `cursor/*`). To reset and run again:

```bash
# 1. Set GITHUB_TOKEN (repo scope) for the target repo
export GITHUB_TOKEN=ghp_...

# 2. Delete previous argus branches
npx argus cleanup

# 3. Run the demo again
npx argus run intents/oauth2-auth.intent.yaml
```

Use `argus cleanup --dry-run` to preview which branches would be deleted.

## Architecture

See [docs/argus-implementation-plan.md](docs/argus-implementation-plan.md) for the full implementation plan.
