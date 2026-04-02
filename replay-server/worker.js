import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'

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

async function loadTrustedSignerAllowlist(env) {
  const configured = parseTrustedSignerAllowlist(env.REPLAY_TRUSTED_SIGNER_KEYS || '')
  if (configured.size > 0) {
    return { allowlist: configured, autoEnroll: false }
  }

  const stored = await env.SESSIONS.get('__trusted_signers__')
  if (!stored) {
    return { allowlist: configured, autoEnroll: true }
  }

  try {
    return {
      allowlist: parseTrustedSignerAllowlist(JSON.parse(stored)),
      autoEnroll: true,
    }
  } catch {
    return { allowlist: configured, autoEnroll: true }
  }
}

async function persistTrustedSignerAllowlist(env, allowlist) {
  await env.SESSIONS.put('__trusted_signers__', JSON.stringify(Array.from(allowlist).sort()))
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const payload = await request.json().catch(() => null)
      try {
        const { allowlist: trustedSignerAllowlist, autoEnroll } = await loadTrustedSignerAllowlist(
          env,
        )
        const parsed = await parseReplayAttestation(payload)
        const signerPubkeyHex = parsed.signerPubkeyHex.toLowerCase()
        if (!trustedSignerAllowlist.has(signerPubkeyHex)) {
          if (!autoEnroll) {
            throw new Error('Untrusted Handtyped signer public key')
          }
          trustedSignerAllowlist.add(signerPubkeyHex)
          await persistTrustedSignerAllowlist(env, trustedSignerAllowlist)
        }
        const session = {
          id: crypto.randomUUID(),
          created_at: new Date().toISOString(),
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
        return json({
          id: session.id,
          url: buildReplayUrl(url.origin, session.id),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid replay upload'
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

    if (request.method === 'GET' && /^\/replay\/[^/]+$/.test(url.pathname)) {
      return serveReplayHtml(request, env)
    }

    return env.ASSETS.fetch(request)
  },
}
