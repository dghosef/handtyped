# Cloudflare Deploy

This replay server can run for free on Cloudflare using:

- static assets from `public/`
- a Worker in `worker.js`
- a KV namespace bound as `SESSIONS` for replay session storage
- a D1 database bound as `EDU_DB` for classroom, assignment, teacher, live-session, and EDU replay metadata

Production hostnames:

- `https://handtyped.app`
- `https://www.handtyped.app`
- `https://replay.handtyped.app`

## One-time setup

1. `cd replay-server`
2. `npm install`
3. `npx wrangler login`
4. `npx wrangler kv namespace create SESSIONS`
5. `npx wrangler d1 create handtyped-edu`
6. Copy the returned IDs into [wrangler.toml](/Users/dghosef/handtyped/handtyped/replay-server/wrangler.toml):

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "your-production-namespace-id"
preview_id = "your-preview-namespace-id"

[[d1_databases]]
binding = "EDU_DB"
database_name = "handtyped-edu"
database_id = "your-production-d1-database-id"
preview_database_id = "your-preview-d1-database-id"
```

7. Apply the EDU schema:

```bash
npx wrangler d1 migrations apply handtyped-edu
```

If you prefer, recent Wrangler versions can also provision resources automatically when IDs are omitted. See Cloudflare’s Wrangler configuration docs:
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/)
- [Static assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)

## Local Cloudflare-style dev

```bash
npm run cf:dev
```

## Deploy

```bash
npm run cf:deploy
```

The deployed Worker should serve production traffic from `https://handtyped.app`, `https://www.handtyped.app`, and `https://replay.handtyped.app`.

## What gets deployed

- `POST /api/sessions` stores a replay session in KV
- `GET /api/sessions/:id` loads a session from KV
- EDU classroom, assignment, teacher auth session, live-session, and EDU replay metadata live in D1 when `EDU_DB` is bound
- `GET /api/health` reports replay upload health, trust source, and recent failure counts
- `GET /:id` serves `public/replay.html`
- `GET /replay/:id` remains as a compatibility alias
- all static assets in `public/` are served by Cloudflare assets

## Trust model

- The replay host is replay-only; the root path returns 404.
- Replay uploads must be signed by a trusted Handtyped public key.
- The server rejects unsigned uploads, untrusted signers, non-SPI keyboard uploads, and runtime tampering flags.
- For a self-hosted deployment, point `REPLAY_TRUSTED_SIGNER_KEYS` at the trusted public key or provide `HANDTYPED_TRUSTED_SIGNER_FILE`.
- For a local same-machine setup, the app writes its public key to `~/.config/handtyped/pubkey.hex` and the server can read that file automatically.
