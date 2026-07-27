# Telegram Canvas

A Telegram Mini App that lets you browse, live-view, revise, and manage HTML
artifacts scoped to your own Hermes sessions.

## Architecture

```
Telegram Mini App  ──►  Cloudflare Worker  ──►  D1 + R2 + Durable Objects
       │                        ▲
       │                        │ HMAC-sign
       ▼                        │
  Hermes Agent ──────────── canvas_publish tool
```

- **Worker**: Cloudflare Workers with D1 metadata, R2 revision blobs, and Durable
  Object WebSocket rooms.
- **Mini App**: Vanilla TypeScript frontend, built by Vite, served as Workers
  Assets. Opens from the Telegram bot menu button.
- **Plugin**: Hermes directory plugin adding a `canvas_publish` tool.

## Repository Layout

```
telegram-canvas/
├── .github/workflows/   — CI and production/preview deployment
├── worker/
│   ├── src/             — Worker TypeScript source
│   ├── public/          — Mini App frontend (Vite build)
│   ├── test/            — Vitest + Miniflare integration tests
│   ├── package.json
│   ├── wrangler.jsonc   — Cloudflare Workers configuration
│   └── vite.config.ts   — Frontend build config
├── hermes-plugin/       — Hermes canvas_publish plugin
├── scripts/             — One-shot provisioning and configuration
├── docs/                — Operations, setup, and threat model
└── .dev.vars.example    — Required secret names (copy to .dev.vars)
```

## Local Development

```bash
cd worker
npm ci
npm run dev          # Vite dev server + wrangler dev
npm test             # Vitest with Miniflare integration
npx wrangler deploy --dry-run  # Validate config without deploying
```

## Required Secrets

| Secret | Where | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Worker secret, `.dev.vars` | Verify Telegram WebApp init data |
| `PUBLISHER_SECRET` | Worker secret, Hermes env | HMAC sign publish requests |
| `IDENTITY_HMAC_KEY` | Worker secret | Derive owner/session hashes |
| `DOCUMENT_TOKEN_KEY` | Worker secret | Mint document tokens |

## License

MIT
