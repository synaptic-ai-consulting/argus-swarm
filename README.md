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
4. Optional: `OPENAI_API_KEY` for LLM-based confidence scoring in validation

## Commands

### Run and orchestration
- `argus run <intent-file>` - Decompose intent and launch agent swarm (N=5)
- `argus agents list` - List running agents

### Intents
- `argus intent list` - List available intent files
- `argus intent add <name>` - Create new intent from template

### Review (exception-based human oversight)
- `argus review list` - List exceptions pending review
- `argus review approve <id>` - Approve an exception
- `argus review reject <id>` - Reject an exception
- `argus review show <id>` - Show exception details

### Infrastructure
- `argus webhook serve` - Start webhook server (use with ngrok for local testing)
- `argus ui` - Start minimal web UI for monitoring and decisions
- `argus trust show <agent-id>` - Show trust score for an agent

## Architecture

See [docs/argus-implementation-plan.md](docs/argus-implementation-plan.md) for the full implementation plan.
