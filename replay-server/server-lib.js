/**
 * Express app factory — separated from server.js so tests can import it
 * without starting a listening server.
 */
import express from 'express'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_ORIGIN = process.env.REPLAY_SERVER_PUBLIC_ORIGIN || 'https://replay.handtyped.app'

function loadTrustedSignerAllowlist(config = {}) {
  if (config.trustedSignerAllowlist instanceof Set) {
    return () => config.trustedSignerAllowlist
  }

  if (Array.isArray(config.trustedSignerKeys)) {
    const allowlist = parseTrustedSignerAllowlist(config.trustedSignerKeys)
    return () => allowlist
  }

  return () => {
    const envAllowlist = parseTrustedSignerAllowlist(process.env.REPLAY_TRUSTED_SIGNER_KEYS || '')
    if (envAllowlist.size > 0) {
      return envAllowlist
    }

    const fallbackPath =
      process.env.HANDTYPED_TRUSTED_SIGNER_FILE ||
      join(os.homedir(), '.config', 'handtyped', 'pubkey.hex')
    if (existsSync(fallbackPath)) {
      return parseTrustedSignerAllowlist(readFileSync(fallbackPath, 'utf8'))
    }

    return envAllowlist
  }
}

function allowlistFilePath(sessionsDir) {
  return join(sessionsDir, 'trusted-signers.json')
}

function readAllowlistFromFile(path) {
  if (!existsSync(path)) {
    return new Set()
  }
  try {
    const raw = readFileSync(path, 'utf8')
    return parseTrustedSignerAllowlist(JSON.parse(raw))
  } catch {
    return new Set()
  }
}

function persistAllowlistToFile(path, allowlist) {
  writeFileSync(path, JSON.stringify(Array.from(allowlist).sort(), null, 2))
}

export function createApp(sessionsDir, config = {}) {
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true })
  const getConfiguredAllowlist = loadTrustedSignerAllowlist(config)
  const trustFilePath = allowlistFilePath(sessionsDir)
  const allowlist = new Set([
    ...Array.from(getConfiguredAllowlist()),
    ...Array.from(readAllowlistFromFile(trustFilePath)),
  ])
  const hasExplicitTrustConfig =
    config.autoEnroll !== undefined
      ? !config.autoEnroll
      : Boolean(process.env.REPLAY_TRUSTED_SIGNER_KEYS) ||
        config.trustedSignerAllowlist instanceof Set ||
        Array.isArray(config.trustedSignerKeys)
  const autoEnroll = config.autoEnroll !== undefined ? config.autoEnroll : !hasExplicitTrustConfig

  const app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use(express.static(join(__dirname, 'public')))

  // POST /api/sessions — store a session, return a replay URL
  app.post('/api/sessions', async (req, res) => {
    try {
      const parsed = await parseReplayAttestation(req.body)
      const signerPubkeyHex = parsed.signerPubkeyHex.toLowerCase()
      if (!allowlist.has(signerPubkeyHex)) {
        if (!autoEnroll) {
          throw new Error('Untrusted Handtyped signer public key')
        }
        allowlist.add(signerPubkeyHex)
        persistAllowlistToFile(trustFilePath, allowlist)
      }

      const session = {
        id: globalThis.crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...parsed.normalizedPayload,
        verification: {
          verified: true,
          verified_at: new Date().toISOString(),
          version: req.body?.version ?? 1,
          format: req.body?.format ?? 'handtyped-replay-attestation-v1',
          signer_pubkey_hex: parsed.signerPubkeyHex,
          signature_hex: req.body?.signature_hex,
        },
      }
      writeFileSync(join(sessionsDir, `${session.id}.json`), JSON.stringify(session, null, 2))
      res.json({ id: session.id, url: buildReplayUrl(PUBLIC_ORIGIN, session.id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid replay upload'
      res.status(400).json({ error: message })
    }
  })

  // GET /api/sessions/:id — return session data
  app.get('/api/sessions/:id', (req, res) => {
    const path = join(sessionsDir, `${req.params.id}.json`)
    if (!existsSync(path)) return res.status(404).json({ error: 'Not found' })
    res.json(JSON.parse(readFileSync(path, 'utf8')))
  })

  // GET /replay/:id — serve the replay page
  app.get('/replay/:id', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'replay.html'))
  })

  return app
}
