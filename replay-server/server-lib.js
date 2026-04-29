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
  buildLiveReplayEvent,
  buildLiveReplayHead,
  buildLiveSession,
  nowIso,
} from './edu-schema.js'
import {
  buildAssignmentLiveSummaries,
  buildAssignmentAuditRecord,
  buildEduDashboard,
  buildEduDashboardDelta,
  buildStudentAssignmentConfig,
  buildStudentConfig,
  createNodeEduStore,
  ensureEduSeedData,
} from './edu-store.js'
import {
  authenticateTeacher,
  authenticateTeacherWithGoogle,
  clearTeacherSessionCookie,
  createTeacherSession,
  destroyTeacherSession,
  getTeacherSession,
  teacherSessionCookie,
} from './edu-auth.js'
import { verifyGoogleIdToken } from './edu-google-auth.js'

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

function liveReplayHeadFromSession(session, existingHead = null, replay = null) {
  return buildLiveReplayHead({
    ...existingHead,
    id: session.id,
    live_session_id: session.id,
    replay_session_id: session.replay_session_id || existingHead?.replay_session_id || replay?.id || null,
    assignment_id: session.assignment_id,
    assignment_title: session.assignment_title,
    course: session.course,
    classroom: session.classroom,
    student_name: session.student_name,
    current_text: session.current_text,
    document_history: session.document_history,
    focus_events: session.focus_events,
    keystroke_log: session.keystroke_log,
    current_url: session.current_url,
    current_url_title: session.current_url_title,
    url_history: session.url_history,
    violation_count: session.violation_count,
    violations: session.violations,
    last_activity_at: session.last_activity_at,
    focused: session.focused,
    hid_active: session.hid_active,
    start_wall_ns: replay?.start_wall_ns || existingHead?.start_wall_ns || 0,
    replay_origin_wall_ms: replay?.replay_origin_wall_ms ?? existingHead?.replay_origin_wall_ms ?? null,
    recorded_timezone_offset_minutes:
      replay?.recorded_timezone_offset_minutes ?? existingHead?.recorded_timezone_offset_minutes ?? null,
    recorded_timezone: replay?.recorded_timezone ?? existingHead?.recorded_timezone ?? null,
    snapshot_history_count: Array.isArray(session.document_history) ? session.document_history.length : 0,
    snapshot_url_history_count: Array.isArray(session.url_history) ? session.url_history.length : 0,
    created_at: existingHead?.created_at || nowIso(),
    updated_at: nowIso(),
  })
}

function buildLiveReplayResponse(head, events = [], replay = null) {
  return {
    id: head.id,
    live_session_id: head.live_session_id || head.id,
    replay_session_id: head.replay_session_id || replay?.id || null,
    assignment_id: head.assignment_id,
    assignment_title: head.assignment_title,
    course: head.course,
    classroom: head.classroom,
    student_name: head.student_name,
    current_text: head.current_text,
    document_history: Array.isArray(head.document_history) ? head.document_history : [],
    focus_events: Array.isArray(head.focus_events) ? head.focus_events : [],
    keystroke_log: String(head.keystroke_log || ''),
    current_url: head.current_url ?? null,
    current_url_title: head.current_url_title ?? null,
    url_history: Array.isArray(head.url_history) ? head.url_history : [],
    violation_count: Number(head.violation_count ?? 0),
    violations: Array.isArray(head.violations) ? head.violations : [],
    last_activity_at: head.last_activity_at,
    focused: head.focused,
    hid_active: head.hid_active,
    start_wall_ns: replay?.start_wall_ns || head.start_wall_ns || 0,
    replay_origin_wall_ms: replay?.replay_origin_wall_ms ?? head.replay_origin_wall_ms ?? null,
    recorded_timezone_offset_minutes:
      replay?.recorded_timezone_offset_minutes ?? head.recorded_timezone_offset_minutes ?? null,
    recorded_timezone: replay?.recorded_timezone ?? head.recorded_timezone ?? null,
    last_seq: Number(head.last_event_seq ?? 0),
    events,
    created_at: head.created_at,
    updated_at: head.updated_at,
  }
}

async function appendLiveReplayUpdate(eduStore, session, replay = null) {
  const existingHead = await eduStore.getLiveReplayHead(session.id)
  const previousHistoryCount = Number(existingHead?.snapshot_history_count ?? 0)
  const previousUrlHistoryCount = Number(existingHead?.snapshot_url_history_count ?? 0)
  const history = Array.isArray(session.document_history) ? session.document_history : []
  const urlHistory = Array.isArray(session.url_history) ? session.url_history : []
  const documentHistoryTail = history.slice(Math.max(0, previousHistoryCount))
  const urlHistoryTail = urlHistory.slice(Math.max(0, previousUrlHistoryCount))

  const hasMeaningfulChange =
    !existingHead ||
    documentHistoryTail.length > 0 ||
    urlHistoryTail.length > 0 ||
    String(existingHead.current_text || '') !== String(session.current_text || '') ||
    String(existingHead.current_url || '') !== String(session.current_url || '') ||
    String(existingHead.current_url_title || '') !== String(session.current_url_title || '') ||
    String(existingHead.last_activity_at || '') !== String(session.last_activity_at || '')

  const nextSeq = Math.max(0, Number(existingHead?.last_event_seq ?? 0)) + (hasMeaningfulChange ? 1 : 0)
  const head = liveReplayHeadFromSession(
    {
      ...session,
      document_history: history,
      url_history: urlHistory,
    },
    {
      ...existingHead,
      last_event_seq: nextSeq,
    },
    replay,
  )

  await eduStore.putLiveReplayHead(head)

  if (!hasMeaningfulChange) {
    return head
  }

  const event = buildLiveReplayEvent({
    id: `${session.id}:${String(nextSeq).padStart(8, '0')}`,
    live_session_id: session.id,
    replay_session_id: head.replay_session_id,
    assignment_id: session.assignment_id,
    student_name: session.student_name,
    seq: nextSeq,
    current_text: session.current_text,
    current_url: session.current_url,
    current_url_title: session.current_url_title,
    document_history_tail: documentHistoryTail,
    url_history_tail: urlHistoryTail,
    last_activity_at: session.last_activity_at,
    focused: session.focused,
    hid_active: session.hid_active,
    created_at: session.updated_at || nowIso(),
    updated_at: session.updated_at || nowIso(),
  })
  await eduStore.appendLiveReplayEvent(event)
  return head
}

function eduGoogleConfig(config = {}) {
  const clientId = String(config.googleClientId || process.env.EDU_GOOGLE_CLIENT_ID || '')
  const hostedDomain = String(
    config.googleHostedDomain || process.env.EDU_GOOGLE_HOSTED_DOMAIN || '',
  ).trim()
  return {
    enabled: Boolean(clientId),
    client_id: clientId,
    hosted_domain: hostedDomain,
  }
}

async function findJoinCodeConflict(store, joinCode, excludeClassroomId = null) {
  const normalizedJoinCode = String(joinCode || '').trim().toUpperCase()
  if (!normalizedJoinCode) {
    return null
  }

  const classrooms = await store.listClassrooms()
  return (
    classrooms.find(
      (classroom) =>
        classroom.id !== excludeClassroomId &&
        String(classroom.join_code || '').trim().toUpperCase() === normalizedJoinCode,
    ) || null
  )
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

  app.get('/app', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'edu', 'app.html'))
  })

  app.get('/edu/login', (_req, res) => {
    res.sendFile(join(__dirname, 'public', 'edu', 'login.html'))
  })

  app.get('/login', (_req, res) => {
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

  app.get('/api/edu/dashboard/updates', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await buildEduDashboardDelta(eduStore, { since: req.query.since }))
  })

  app.get('/api/edu/config', (_req, res) => {
    const google = eduGoogleConfig(config)
    res.json({
      host: 'edu.handtyped.app',
      teacher_surface: 'web',
      student_surface: 'native',
      replay_origin: PUBLIC_ORIGIN,
      auth: {
        password_enabled: true,
        google_enabled: google.enabled,
        google_client_id: google.client_id,
        google_hosted_domain: google.hosted_domain,
      },
    })
  })

  app.get('/api/edu/auth/session', (req, res) => {
    getTeacherSession(eduStore, req.headers.cookie).then((session) => res.json(session))
  })

  app.post('/api/edu/auth/login', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const provider = String(req.body?.provider || '').trim() || 'password'
    let teacher = null
    let providerName = provider

    if (provider === 'google') {
      const google = eduGoogleConfig(config)
      const googleProfile = await verifyGoogleIdToken({
        credential: req.body?.credential,
        clientId: google.client_id,
        hostedDomain: google.hosted_domain,
        mockVerifier: config.googleTokenVerifier || null,
      }).catch(() => null)

      teacher = googleProfile
        ? await authenticateTeacherWithGoogle(eduStore, googleProfile)
        : null
      providerName = 'google'
    } else {
      teacher = await authenticateTeacher(eduStore, {
        email: req.body?.email,
        password: req.body?.password,
        accessCode: req.body?.access_code,
      })
      providerName = req.body?.password ? 'password' : 'access-code'
    }

    if (!teacher) {
      return res.status(401).json({ error: 'Invalid teacher login', authenticated: false })
    }
    const sessionRecord = await createTeacherSession(eduStore, teacher, providerName)
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
    const conflict = await findJoinCodeConflict(eduStore, classroom.join_code)
    if (conflict) {
      return res.status(409).json({ error: 'Join code already in use', join_code: classroom.join_code })
    }
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
    const conflict = await findJoinCodeConflict(eduStore, classroom.join_code, classroom.id)
    if (conflict) {
      return res.status(409).json({ error: 'Join code already in use', join_code: classroom.join_code })
    }
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
    await eduStore.putAssignmentAudit(
      buildAssignmentAuditRecord({ action: 'created', assignment, actor: session }),
    )
    res.status(201).json(assignment)
  })

  app.get('/api/edu/assignments/:id/audit', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = await eduStore.getAssignment(req.params.id)
    if (!assignment) return res.status(404).json({ error: 'Not found' })
    const audits = (await eduStore.listAssignmentAudits()).filter(
      (item) => item.assignment_id === req.params.id,
    )
    res.json(audits)
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

  app.get('/api/edu/assignments/:id/live-summaries', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = await eduStore.getAssignment(req.params.id)
    if (!assignment) return res.status(404).json({ error: 'Not found' })
    res.json({
      assignment_id: req.params.id,
      live_sessions: await buildAssignmentLiveSummaries(eduStore, req.params.id),
      updated_at: nowIso(),
    })
  })

  app.post('/api/edu/assignments/:id/access-requests', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getAssignment(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const studentName = String(req.body?.student_name || '').trim()
    if (!studentName) {
      return res.status(400).json({ error: 'Student name is required' })
    }

    const normalizedKey = studentName.toLowerCase()
    const updatedAssignment = buildAssignment({
      ...existing,
      student_access_requests: {
        ...(existing.student_access_requests || {}),
        [normalizedKey]: {
          student_name: studentName,
          requested_at: nowIso(),
          note: String(req.body?.note || ''),
        },
      },
      updated_at: nowIso(),
    })
    await eduStore.putAssignment(updatedAssignment)
    await eduStore.putAssignmentAudit(
      buildAssignmentAuditRecord({
        action: 'updated',
        assignment: updatedAssignment,
        previousAssignment: existing,
        actor: null,
      }),
    )
    res.status(201).json({
      assignment_id: updatedAssignment.id,
      student_access_request: updatedAssignment.student_access_requests?.[normalizedKey] || null,
    })
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
    await eduStore.putAssignmentAudit(
      buildAssignmentAuditRecord({
        action: 'updated',
        assignment,
        previousAssignment: existing,
        actor: session,
      }),
    )
    res.json(assignment)
  })

  app.delete('/api/edu/assignments/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getAssignment(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    await eduStore.deleteAssignment(req.params.id)
    await eduStore.putAssignmentAudit(
      buildAssignmentAuditRecord({
        action: 'deleted',
        previousAssignment: existing,
        actor: session,
      }),
    )
    res.json({ deleted: true, assignment_id: req.params.id })
  })

  app.get('/api/edu/live-sessions', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json((await eduStore.listLiveSessions()).map((item) => buildLiveSession(item)))
  })

  app.post('/api/edu/live-sessions', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const nextId =
      req.body?.id ||
      `${req.body?.student_name || 'student'}:${req.body?.assignment_id || 'assignment'}`
    const existing = await eduStore.getLiveSession(nextId)
    const incomingCurrentText = Object.hasOwn(req.body || {}, 'current_text')
      ? String(req.body?.current_text || '')
      : null
    const incomingHistory = Array.isArray(req.body?.document_history) ? req.body.document_history : null
    const session = buildLiveSession({
      ...existing,
      ...(req.body || {}),
      id: nextId,
      current_text:
        incomingCurrentText != null
          ? incomingCurrentText || existing?.current_text || ''
          : existing?.current_text || req.body?.current_text || '',
      document_history:
        incomingHistory != null
          ? incomingHistory.length
            ? incomingHistory
            : existing?.document_history || []
          : existing?.document_history || req.body?.document_history || [],
      grading:
        req.body?.grading && typeof req.body.grading === 'object'
          ? req.body.grading
          : existing?.grading,
      updated_at: nowIso(),
    })
    await eduStore.putLiveSession(session)
    await appendLiveReplayUpdate(eduStore, session)
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
    res.json(buildLiveSession(liveSession))
  })

  app.get('/api/edu/live-replays/:id', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const head = await eduStore.getLiveReplayHead(req.params.id)
    if (head) {
      const replay = head.replay_session_id ? await eduStore.getReplay(head.replay_session_id) : null
      return res.json(buildLiveReplayResponse(head, await eduStore.listLiveReplayEvents(head.id), replay))
    }

    const liveSession = await eduStore.getLiveSession(req.params.id)
    if (!liveSession) return res.status(404).json({ error: 'Not found' })
    const replay = liveSession.replay_session_id ? await eduStore.getReplay(liveSession.replay_session_id) : null
    const fallbackHead = liveReplayHeadFromSession(liveSession, null, replay)
    res.json(buildLiveReplayResponse(fallbackHead, [], replay))
  })

  app.get('/api/edu/live-replays/:id/updates', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const head = await eduStore.getLiveReplayHead(req.params.id)
    if (!head) return res.status(404).json({ error: 'Not found' })
    const sinceSeq = Math.max(0, Number(req.query.since_seq ?? 0) || 0)
    const events = (await eduStore.listLiveReplayEvents(head.id)).filter((event) => event.seq > sinceSeq)
    const replay = head.replay_session_id ? await eduStore.getReplay(head.replay_session_id) : null
    res.json({
      id: head.id,
      live_session_id: head.live_session_id || head.id,
      replay_session_id: head.replay_session_id || replay?.id || null,
      current_text: head.current_text,
      current_url: head.current_url ?? null,
      current_url_title: head.current_url_title ?? null,
      last_activity_at: head.last_activity_at,
      last_seq: Number(head.last_event_seq ?? 0),
      replay_origin_wall_ms: replay?.replay_origin_wall_ms ?? head.replay_origin_wall_ms ?? null,
      recorded_timezone_offset_minutes:
        replay?.recorded_timezone_offset_minutes ?? head.recorded_timezone_offset_minutes ?? null,
      recorded_timezone: replay?.recorded_timezone ?? head.recorded_timezone ?? null,
      events,
      updated_at: head.updated_at,
    })
  })

  app.put('/api/edu/live-sessions/:id/grading', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getLiveSession(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const grading = {
      rubric_scores:
        req.body?.rubric_scores && typeof req.body.rubric_scores === 'object'
          ? { ...req.body.rubric_scores }
          : {},
      teacher_comment: String(req.body?.teacher_comment || ''),
      returned_for_revision: Boolean(req.body?.returned_for_revision),
      grade_label: String(req.body?.grade_label || ''),
      grade_score:
        req.body?.grade_score === '' || req.body?.grade_score == null
          ? null
          : Number(req.body?.grade_score),
      inline_annotations: Array.isArray(req.body?.inline_annotations) ? req.body.inline_annotations : [],
      updated_at: nowIso(),
      actor_id: teacherSession.teacher_id || null,
      actor_name: teacherSession.teacher_name || null,
      actor_email: teacherSession.teacher_email || null,
    }
    const updated = buildLiveSession({
      ...existing,
      grading,
      updated_at: nowIso(),
    })
    await eduStore.putLiveSession(updated)
    res.json(updated)
  })

  app.get('/api/edu/replays/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const replay = await eduStore.getReplay(req.params.id)
    if (!replay) return res.status(404).json({ error: 'Not found' })
    const assignment = replay.assignment_id ? await eduStore.getAssignment(replay.assignment_id) : null
    res.json({
      ...replay,
      assignment: assignment || null,
    })
  })

  app.post('/api/edu/replays', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const replay = buildEduReplay({ ...(req.body || {}), updated_at: nowIso() })
    await eduStore.putReplay(replay)
    if (replay.live_session_id) {
      const existingHead = await eduStore.getLiveReplayHead(replay.live_session_id)
      if (existingHead) {
        await eduStore.putLiveReplayHead(
          buildLiveReplayHead({
            ...existingHead,
            replay_session_id: replay.id,
            start_wall_ns: replay.start_wall_ns,
            replay_origin_wall_ms: replay.replay_origin_wall_ms,
            recorded_timezone_offset_minutes: replay.recorded_timezone_offset_minutes,
            recorded_timezone: replay.recorded_timezone,
            updated_at: nowIso(),
          }),
        )
      }
    }
    res.status(201).json(replay)
  })

  app.get('/api/edu/student/config', async (req, res) => {
    await ensureEduSeedData(eduStore)
    res.json(
      await buildStudentConfig(eduStore, {
        joinCode: req.query.join_code || '',
        studentName: req.query.student_name || '',
      }),
    )
  })

  app.get('/api/edu/student/assignments/:id', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const result = await buildStudentAssignmentConfig(eduStore, {
      assignmentId: req.params.id,
      joinCode: req.query.join_code || '',
      studentName: req.query.student_name || '',
    })
    if (!result.classroom || !result.assignment) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.json(result)
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
