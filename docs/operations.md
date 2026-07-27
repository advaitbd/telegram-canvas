# Canvas Operations

## Secret Locations

### Worker Runtime Secrets (Cloudflare)

Set via `wrangler secret put` — never in code or config files:

| Secret | Source | Used for |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | Telegram WebApp init-data HMAC verification |
| `PUBLISHER_SECRET` | `openssl rand -hex 32` | HMAC signing of publish requests |
| `IDENTITY_HMAC_KEY` | `openssl rand -hex 32` | Deterministic owner/session hash derivation |
| `DOCUMENT_TOKEN_KEY` | `open ssl rand -hex 32` (v1) | Short-lived document tokens (to be removed per corrected auth model) |

Set locally in `.dev.vars` (copied from `.dev.vars.example`):
```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with real values
```

### Hermes Plugin Credentials

The plugin reads `CANVAS_WORKER_URL` and `CANVAS_PUBLISHER_SECRET` from the
Hermes environment. These are set in the gateway's profile environment or the
Hermes config file:

```bash
export CANVAS_WORKER_URL=https://canvas.advaitdeshpande.com
export CANVAS_PUBLISHER_SECRET=<same as Worker PUBLISHER_SECRET>
```

### GitHub Deployment Secrets

| Secret | Environment | Used for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | `production` | Wrangler deploy to Cloudflare |
| `TELEGRAM_BOT_TOKEN` | `production` | Worker secret injection |
| `PUBLISHER_SECRET` | `production` | Worker secret injection |
| `IDENTITY_HMAC_KEY` | `production` | Worker secret injection |
| `DOCUMENT_TOKEN_KEY` | `production` | Worker secret injection |

## Local Development

```bash
# Install
cd worker && npm ci

# Dev server (Vite + Wrangler)
npm run dev

# Tests (Vitest with Miniflare)
npm test

# Type check
npx tsc --noEmit

# Validate config without deploying
npx wrangler deploy --dry-run
```

## D1 Migrations

```bash
# Local
npx wrangler d1 migrations apply telegram-canvas --local

# Remote (after Task 2 provisions the database)
npx wrangler d1 migrations apply telegram-canvas --remote
```

## Deployment

Production: push to `main` → GitHub Actions deploy workflow.
Preview: push to PR → deploy to preview worker (requires preview D1/R2 resources).

## Rollback

```bash
# Rollback to the previous version
npx wrangler rollback

# If rollback includes a D1 schema change, apply the previous migration
# forward-only; D1 does not support down migrations.
```

## Teardown

```bash
# Delete the worker
npx wrangler delete telegram-canvas

# Delete D1 database (do this AFTER confirming no worker references it)
npx wrangler d1 delete telegram-canvas

# Delete R2 bucket (must be empty first)
npx wrangler r2 bucket delete telegram-canvas-artifacts
```

## Key Rotation

1. Generate a new secret (`openssl rand -hex 32`)
2. Add it as a new Worker secret alongside the old one (e.g., `PUBLISHER_SECRET_V2`)
3. Update `key-id` in the signing scheme to point clients at the new key
4. Verify old signatures still validate during the grace period
5. Remove the old secret after the grace window expires
