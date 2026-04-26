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
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'
import {
  buildAssignment,
  buildClassroom,
  buildEduReplay,
  nowIso,
} from './edu-schema.js'
import { buildEduDashboard, buildStudentConfig, createNodeEduStore, ensureEduSeedData } from './edu-store.js'
import {
  authenticateTeacher,
  clearTeacherSessionCookie,
  createTeacherSession,
  destroyTeacherSession,
  getTeacherSession,
  teacherSessionCookie,
} from './edu-auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC_ORIGIN = process.env.REPLAY_SERVER_PUBLIC_ORIGIN || 'https://replay.handtyped.app'
const RESERVED_REPLAY_ROOTS = new Set(['api', 'replay'])

function loadTrustedSignerAllowlist(config = {}) {
  let getSource = () => 'missing'

  if (config.trustedSignerAllowlist instanceof Set) {
    getSource = () => 'configured allowlist'
    const getter = () => config.trustedSignerAllowlist
    getter.describe = getSource
    return getter
  }

  if (Array.isArray(config.trustedSignerKeys)) {
    const allowlist = parseTrustedSignerAllowlist(config.trustedSignerKeys)
    getSource = () => 'configured trustedSignerKeys'
    const getter = () => allowlist
    getter.describe = getSource
    return getter
  }

  const getter = () => {
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

  getter.describe = () => {
    const envAllowlist = parseTrustedSignerAllowlist(process.env.REPLAY_TRUSTED_SIGNER_KEYS || '')
    if (envAllowlist.size > 0) {
      return 'environment REPLAY_TRUSTED_SIGNER_KEYS'
    }

    const fallbackPath =
      process.env.HANDTYPED_TRUSTED_SIGNER_FILE ||
      join(os.homedir(), '.config', 'handtyped', 'pubkey.hex')
    if (existsSync(fallbackPath)) {
      return `file ${fallbackPath}`
    }

    return 'missing'
  }
  return getter
}

function sessionFilePath(sessionsDir, id) {
  return join(sessionsDir, `${id}.json`)
}

function serveReplayPage(_req, res) {
  res.sendFile(join(__dirname, 'public', 'replay.html'))
}

function serveEduReplayPage(_req, res) {
  res.sendFile(join(__dirname, 'public', 'edu', 'replay.html'))
}

export function createApp(sessionsDir, config = {}) {
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true })
  const eduStoreDir = config.eduStoreDir || join(sessionsDir, '..', 'edu-store')
  const eduStore = createNodeEduStore(eduStoreDir)
  const getTrustedSignerAllowlist = loadTrustedSignerAllowlist(config)
  const uploadRateLimit = resolveReplayUploadRateLimit(config)
  const guardrails = createReplayGuardrails({
    uploadRateLimitCount: uploadRateLimit.count,
    uploadRateLimitWindowMs: uploadRateLimit.windowMs,
    serverName: 'node-replay-server',
  })

  const app = express()
  app.use(express.json({ limit: '6mb' }))
  app.use(express.static(join(__dirname, 'public')))

  app.get('/edu', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'edu', 'index.html'))
  })

  app.get('/edu/app', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'edu', 'app.html'))
  })

  app.get('/edu/login', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'edu', 'login.html'))
  })

  app.get('/edu/replay/:id', (req, res) => {
    serveEduReplayPage(req, res)
  })

  app.get('/api/edu/dashboard', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await buildEduDashboard(eduStore))
  })

  app.get('/api/edu/config', (_req, res) => {
    res.json({
      host: 'edu.handtyped.app',
      teacher_surface: 'web',
      student_surface: 'native',
      replay_origin: PUBLIC_ORIGIN,
    })
  })

  app.get('/api/edu/auth/session', (req, res) => {
    getTeacherSession(eduStore, req.headers.cookie).then((session) => res.json(session))
  })

  app.post('/api/edu/auth/login', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const teacher = await authenticateTeacher(eduStore, {
      email: req.body?.email,
      accessCode: req.body?.access_code,
    })
    if (!teacher) {
      return res.status(401).json({ error: 'Invalid teacher email or access code', authenticated: false })
    }
    const sessionRecord = await createTeacherSession(eduStore, teacher)
    res.setHeader('Set-Cookie', teacherSessionCookie(sessionRecord.id))
    res.json(
      await getTeacherSession(
        eduStore,
        `${req.headers.cookie || ''}; edu_teacher_session=${sessionRecord.id}`,
      ),
    )
  })

  app.post('/api/edu/auth/logout', async (req, res) => {
    await destroyTeacherSession(eduStore, req.headers.cookie)
    res.setHeader('Set-Cookie', clearTeacherSessionCookie())
    res.json({ authenticated: false, teacher_id: null, teacher_name: null, teacher_email: null })
  })

  app.get('/api/edu/classrooms', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await eduStore.listClassrooms())
  })

  app.post('/api/edu/classrooms', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const classroom = buildClassroom(req.body || {})
    classroom.updated_at = nowIso()
    await eduStore.putClassroom(classroom)
    res.status(201).json(classroom)
  })

  app.get('/api/edu/classrooms/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const classroom = await eduStore.getClassroom(req.params.id)
    if (!classroom) return res.status(404).json({ error: 'Not found' })
    res.json(classroom)
  })

  app.put('/api/edu/classrooms/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const classroom = buildClassroom({ ...existing, ...(req.body || {}), id: req.params.id, updated_at: nowIso() })
    await eduStore.putClassroom(classroom)
    res.json(classroom)
  })

  app.delete('/api/edu/classrooms/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const assignments = await eduStore.listAssignments()
    for (const assignment of assignments.filter((item) => item.classroom_id === req.params.id)) {
      await eduStore.deleteAssignment(assignment.id)
    }
    await eduStore.deleteClassroom(req.params.id)
    res.json({ deleted: true, classroom_id: req.params.id })
  })

  app.get('/api/edu/assignments', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await eduStore.listAssignments())
  })

  app.post('/api/edu/assignments', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = buildAssignment(req.body || {})
    assignment.updated_at = nowIso()
    await eduStore.putAssignment(assignment)
    res.status(201).json(assignment)
  })

  app.get('/api/edu/assignments/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = await eduStore.getAssignment(req.params.id)
    if (!assignment) return res.status(404).json({ error: 'Not found' })
    res.json(assignment)
  })

  app.put('/api/edu/assignments/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getAssignment(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const assignment = buildAssignment({ ...existing, ...(req.body || {}), id: req.params.id, updated_at: nowIso() })
    await eduStore.putAssignment(assignment)
    res.json(assignment)
  })

  app.get('/api/edu/live-sessions', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await eduStore.listLiveSessions())
  })

  app.post('/api/edu/live-sessions', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const session = {
      ...(req.body || {}),
      id:
        req.body?.id ||
        `${req.body?.student_name || 'student'}:${req.body?.assignment_id || 'assignment'}`,
      updated_at: nowIso(),
    }
    await eduStore.putLiveSession(session)
    res.status(201).json(session)
  })

  app.get('/api/edu/live-sessions/:id', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const liveSession = await eduStore.getLiveSession(req.params.id)
    if (!liveSession) return res.status(404).json({ error: 'Not found' })
    res.json(liveSession)
  })

  app.get('/api/edu/replays/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const replay = await eduStore.getReplay(req.params.id)
    if (!replay) return res.status(404).json({ error: 'Not found' })
    res.json(replay)
  })

  app.post('/api/edu/replays', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const replay = buildEduReplay({ ...(req.body || {}), updated_at: nowIso() })
    await eduStore.putReplay(replay)
    res.status(201).json(replay)
  })

  app.get('/api/edu/student/config', async (req, res) => {
    await ensureEduSeedData(eduStore)
    res.json(await buildStudentConfig(eduStore, { joinCode: req.query.join_code || '' }))
  })

  app.get('/api/health', (_req, res) => {
    const trustedSignerAllowlist = getTrustedSignerAllowlist()
    res.json(
      guardrails.snapshotHealth({
        trustedSignerSource: getTrustedSignerAllowlist.describe?.() || 'missing',
        trustedSignerCount: trustedSignerAllowlist.size,
      }),
    )
  })

  // POST /api/sessions — store a session, return a replay URL
  app.post('/api/sessions', async (req, res) => {
    try {
      const clientIp =
        req.headers['cf-connecting-ip'] ||
        String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        'unknown'
      const rateLimit = guardrails.checkUploadRateLimit(clientIp)
      if (!rateLimit.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil(rateLimit.retryAfterMs / 1000))
        guardrails.recordUploadAttempt({ ok: false, reason: 'rate_limited', ip: clientIp })
        res.set('Retry-After', String(retryAfterSeconds))
        return res.status(429).json({
          error: 'Replay upload rate limit exceeded',
          retry_after_seconds: retryAfterSeconds,
        })
      }

      const parsed = await parseReplayAttestation(req.body)
      const signerPubkeyHex = parsed.signerPubkeyHex.toLowerCase()
      const trustedSignerAllowlist = getTrustedSignerAllowlist()
      if (!trustedSignerAllowlist.has(signerPubkeyHex)) {
        throw new Error('Untrusted Handtyped signer public key')
      }

      const sessionId = parsed.normalizedPayload.session_id
      const path = sessionFilePath(sessionsDir, sessionId)
      const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      const createdAt = existing?.created_at || new Date().toISOString()
      const session = {
        id: sessionId,
        created_at: createdAt,
        updated_at: new Date().toISOString(),
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
      writeFileSync(path, JSON.stringify(session, null, 2))
      guardrails.recordUploadAttempt({ ok: true, ip: clientIp, sessionId: session.id })
      res.json({ id: session.id, url: buildReplayUrl(PUBLIC_ORIGIN, session.id) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid replay upload'
      guardrails.recordUploadAttempt({
        ok: false,
        reason: message,
        ip:
          req.headers['cf-connecting-ip'] ||
          String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
          req.ip ||
          req.socket?.remoteAddress ||
          'unknown',
      })
      res.status(400).json({ error: message })
    }
  })

  // GET /api/sessions/:id — return session data
  app.get('/api/sessions/:id', (req, res) => {
    const path = sessionFilePath(sessionsDir, req.params.id)
    if (!existsSync(path)) return res.status(404).json({ error: 'Not found' })
    res.json(JSON.parse(readFileSync(path, 'utf8')))
  })

  // GET /:id and GET /replay/:id — serve the replay page
  app.get(/^\/([^/.]+)$/, (req, res, next) => {
    if (RESERVED_REPLAY_ROOTS.has(req.params[0])) {
      return next()
    }
    serveReplayPage(req, res)
  })

  app.get('/replay/:id', (req, res) => {
    serveReplayPage(req, res)
  })

  return app
}
