# Canvas Operations

## Provisioned Cloudflare Resources

| Resource | Name | ID / Details |
|---|---|---|
| Worker | `telegram-canvas` | Version `4fabe143-9d8a-43cf-806d-884b2b1ded59` |
| D1 Database | `telegram-canvas` | `fa7685ec-cea5-49fb-ae03-a6f932a78234` |
| R2 Bucket | `telegram-canvas-artifacts` | Standard storage class |
| Durable Object | `ArtifactRoom` | SQLite-backed, v1 migration |
| Worker Route | `canvas.advaitdeshpande.com/*` | Zone: advaitdeshpande.com |
| DNS Record | `canvas.advaitdeshpande.com` | A → `192.0.2.1` (proxied) |
| Cron Trigger | `0 3 * * *` | Daily maintenance |

### Deployment Token

The deploy token is stored as `CLOUDFLARE_CANVAS_DEPLOY_TOKEN` in `.bashrc`.
It is **not** available in non-interactive shells. Use the following pattern
for all wrangler/cloudflare commands:

```bash
bash -ic 'export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"; wrangler <command>' 2>/dev/null
```

The token is scoped to the subprocess and never printed.

## Secret Locations

### Worker Runtime Secrets (Cloudflare)

Set via `wrangler secret put` — never in code or config files:

| Secret | Source | Used for |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | Telegram WebApp init-data HMAC verification |
| `PUBLISHER_SECRET` | `openssl rand -hex 32` | HMAC signing of publish requests |
| `IDENTITY_HMAC_KEY` | `openssl rand -hex 32` | Deterministic owner/session hash derivation |
| `DOCUMENT_TOKEN_KEY` | `openssl rand -hex 32` | Short-lived document tokens |

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

# Build frontend assets
npm run build

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
# Local (Miniflare)
npx wrangler d1 migrations apply telegram-canvas --local

# Remote production database
npx wrangler d1 migrations apply telegram-canvas --remote
```

## Deployment

Production: push to `main` → GitHub Actions deploy workflow.
Preview: push to PR → deploy to preview worker (requires preview D1/R2 resources).

Manual deploy:
```bash
bash -ic '
export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"
cd worker
npx wrangler deploy
' 2>/dev/null
```

## Rollback

```bash
# Rollback to the previous version
npx wrangler rollback

# If rollback includes a D1 schema change, apply the previous migration
# forward-only; D1 does not support down migrations.
```

## Teardown

```bash
# 1. Delete the DNS record for canvas.advaitdeshpande.com
# Record ID: 4500490415cbccfb6099f21f64e50d55

# 2. Delete the worker (this also removes routes and cron triggers)
bash -ic 'export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"; wrangler delete telegram-canvas' 2>/dev/null

# 3. Delete D1 database (do this AFTER confirming no worker references it)
bash -ic 'export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"; wrangler d1 delete telegram-canvas' 2>/dev/null

# 4. Delete R2 bucket (must be empty first — manually delete all objects or
#    use the R2 dashboard to empty it)
bash -ic 'export CLOUDFLARE_API_TOKEN="$CLOUDFLARE_CANVAS_DEPLOY_TOKEN"; wrangler r2 bucket delete telegram-canvas-artifacts' 2>/dev/null

# 5. Optionally delete the GitHub repository
#    gh repo delete advaitbd/telegram-canvas
```

## Key Rotation

1. Generate a new secret (`openssl rand -hex 32`)
2. Add it as a new Worker secret alongside the old one (e.g., `PUBLISHER_SECRET_V2`)
3. Update `key-id` in the signing scheme to point clients at the new key
4. Verify old signatures still validate during the grace period
5. Remove the old secret after the grace window expires
