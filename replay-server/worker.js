import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'

const RESERVED_REPLAY_ROOTS = new Set(['api', 'replay'])
const REPLAY_HOSTS = new Set(['replay.handtyped.app'])
let guardrailsState = null
let guardrailsStateKey = ''

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  })
}

async function serveReplayHtml(request, env) {
  return env.ASSETS.fetch(new URL('/replay.html', request.url))
}

function isCanonicalReplayPath(pathname) {
  if (!/^\/[^/.]+$/.test(pathname)) {
    return false
  }

  return !RESERVED_REPLAY_ROOTS.has(pathname.slice(1))
}

function isReplayHost(hostname) {
  return REPLAY_HOSTS.has(hostname)
}

function notFound() {
  return new Response('Not found', { status: 404 })
}

async function parseJsonRequest(request) {
  const encoding = request.headers.get('content-encoding')?.toLowerCase()
  if (encoding === 'gzip') {
    const stream = new Blob([await request.arrayBuffer()])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'))
    const text = await new Response(stream).text()
    return JSON.parse(text)
  }
  return request.json()
}

async function loadTrustedSignerAllowlist(env) {
  const configured = parseTrustedSignerAllowlist(env.REPLAY_TRUSTED_SIGNER_KEYS || '')
  if (configured.size > 0) {
    loadTrustedSignerAllowlist.describe = () => 'environment REPLAY_TRUSTED_SIGNER_KEYS'
    return configured
  }

  const stored = await env.SESSIONS.get('__trusted_signers__')
  if (!stored) {
    loadTrustedSignerAllowlist.describe = () => 'missing'
    return configured
  }

  try {
    const allowlist = parseTrustedSignerAllowlist(JSON.parse(stored))
    loadTrustedSignerAllowlist.describe = () => 'stored allowlist'
    return allowlist
  } catch {
    loadTrustedSignerAllowlist.describe = () => 'missing'
    return configured
  }
}

function getGuardrails(env) {
  const uploadRateLimit = resolveReplayUploadRateLimit(
    {
      uploadRateLimitCount: env.REPLAY_UPLOAD_RATE_LIMIT_COUNT,
      uploadRateLimitWindowMs: env.REPLAY_UPLOAD_RATE_LIMIT_WINDOW_MS,
    },
    {},
  )
  const key = JSON.stringify(uploadRateLimit)
  if (!guardrailsState || guardrailsStateKey !== key) {
    guardrailsState = createReplayGuardrails({
      uploadRateLimitCount: uploadRateLimit.count,
      uploadRateLimitWindowMs: uploadRateLimit.windowMs,
      serverName: 'cloudflare-worker',
    })
    guardrailsStateKey = key
  }
  return guardrailsState
}

function getRequestIp(request) {
  const cfIp = request.headers.get('cf-connecting-ip')
  if (cfIp && cfIp.trim()) {
    return cfIp.trim()
  }

  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }

  return 'unknown'
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const replayHost = isReplayHost(url.hostname)
    const guardrails = getGuardrails(env)

    if (replayHost && url.pathname === '/') {
      return notFound()
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      const trustedSignerAllowlist = await loadTrustedSignerAllowlist(env)
      return json(
        guardrails.snapshotHealth({
          trustedSignerSource: loadTrustedSignerAllowlist.describe?.() || 'missing',
          trustedSignerCount: trustedSignerAllowlist.size,
        }),
      )
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const clientIp = getRequestIp(request)
      const rateLimit = guardrails.checkUploadRateLimit(clientIp)
      if (!rateLimit.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))
        guardrails.recordUploadAttempt({ ok: false, reason: 'rate_limited', ip: clientIp })
        return json(
          {
            error: 'Replay upload rate limit exceeded',
            retry_after_seconds: retryAfterSeconds,
          },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfterSeconds) },
          },
        )
      }

      const payload = await parseJsonRequest(request).catch(() => null)
      try {
        const trustedSignerAllowlist = await loadTrustedSignerAllowlist(env)
        const parsed = await parseReplayAttestation(payload)
        const signerPubkeyHex = parsed.signerPubkeyHex.toLowerCase()
        if (!trustedSignerAllowlist.has(signerPubkeyHex)) {
          throw new Error('Untrusted Handtyped signer public key')
        }
        const sessionId = parsed.normalizedPayload.session_id
        const existingRaw = await env.SESSIONS.get(sessionId)
        const existing = existingRaw ? JSON.parse(existingRaw) : null
        const createdAt = existing?.created_at || new Date().toISOString()
        const session = {
          id: sessionId,
          created_at: createdAt,
          updated_at: new Date().toISOString(),
          ...parsed.normalizedPayload,
          verification: {
            verified: true,
            verified_at: new Date().toISOString(),
            version: payload?.version ?? 1,
            format: payload?.format ?? 'handtyped-replay-attestation-v1',
            signer_pubkey_hex: parsed.signerPubkeyHex,
            signature_hex: payload?.signature_hex,
          },
        }
        await env.SESSIONS.put(session.id, JSON.stringify(session))
        guardrails.recordUploadAttempt({ ok: true, ip: clientIp, sessionId: session.id })
        return json({
          id: session.id,
          url: buildReplayUrl(url.origin, session.id),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid replay upload'
        guardrails.recordUploadAttempt({
          ok: false,
          reason: message,
          ip: clientIp,
        })
        return json({ error: message }, { status: 400 })
      }
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      const id = url.pathname.split('/').pop()
      const stored = id ? await env.SESSIONS.get(id) : null
      if (!stored) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return new Response(stored, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }

    if (
      request.method === 'GET' &&
      (isCanonicalReplayPath(url.pathname) || /^\/replay\/[^/]+$/.test(url.pathname))
    ) {
      return serveReplayHtml(request, env)
    }

    return env.ASSETS.fetch(request)
  },
}
