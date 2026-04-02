# Cloudflare Deploy

This replay server can run for free on Cloudflare using:

- static assets from `public/`
- a Worker in `worker.js`
- a KV namespace bound as `SESSIONS`

Production hostnames:

- `https://handtyped.app`
- `https://www.handtyped.app`
- `https://replay.handtyped.app`

## One-time setup

1. `cd replay-server`
2. `npm install`
3. `npx wrangler login`
4. `npx wrangler kv namespace create SESSIONS`
5. Copy the returned namespace IDs into [wrangler.toml](/Users/dghosef/editor/replay-server/wrangler.toml):

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "your-production-namespace-id"
preview_id = "your-preview-namespace-id"
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
- `GET /replay/:id` serves `public/replay.html`
- all static assets in `public/` are served by Cloudflare assets
