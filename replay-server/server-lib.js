/**
 * Express app factory — separated from server.js so tests can import it
 * without starting a listening server.
 */
import express from 'express'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'
import {
  DEFAULT_TENANT_ID,
  buildAssignment,
  buildClassroom,
  buildEduReplay,
  buildLiveReplayEvent,
  buildLiveReplayHead,
  buildLiveSession,
  mergeLiveSessionDraft,
  nowIso,
} from './edu-schema.js'
import {
  buildAssignmentLiveSummaries,
  buildAssignmentAuditRecord,
  buildEduDashboard,
  buildEduDashboardDelta,
  buildStudentActiveAssignmentState,
  buildStudentAssignmentConfig,
  buildStudentConfig,
  createNodeEduStore,
  ensureEduSeedData,
  assignmentTimingFieldsChanged,
  assignmentWithRejoinHistoryReset,
  recordStudentAssignmentClose,
  recordStudentAssignmentOpen,
  removeClassroomStudent,
  renameClassroomStudent,
  scheduleStateForAssignment,
} from './edu-store.js'
import {
  authenticateTeacher,
  authenticateTeacherWithGoogle,
  createTeacherAccount,
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
const LIVE_REPLAY_INLINE_TEXT_LIMIT = 50_000

function teacherTenantId(session) {
  return session?.tenant_id || DEFAULT_TENANT_ID
}

function gradingHasStudentVisibleFeedback(grading = {}) {
  return Boolean(
    String(grading?.teacher_comment || '').trim() ||
      String(grading?.grade_label || '').trim() ||
      grading?.grade_score != null ||
      Boolean(grading?.returned_for_revision) ||
      (Array.isArray(grading?.inline_annotations) && grading.inline_annotations.length > 0) ||
      (grading?.rubric_scores &&
        typeof grading.rubric_scores === 'object' &&
        Object.values(grading.rubric_scores).some((value) => Number(value || 0) > 0)),
  )
}

function studentFeedbackRequestsAfterFeedback(assignment, studentName) {
  const key = String(studentName || '').trim().toLowerCase()
  const requests = { ...(assignment?.student_feedback_requests || {}) }
  if (key) {
    delete requests[key]
  }
  return requests
}

function studentFeedbackRequestForStudent(assignment, studentName) {
  const key = String(studentName || '').trim().toLowerCase()
  const requests = assignment?.student_feedback_requests
  return key && requests && typeof requests === 'object' ? requests[key] || null : null
}

function dateMsOrNull(value) {
  const ms = Date.parse(String(value || ''))
  return Number.isFinite(ms) ? ms : null
}

function liveSessionActivityIsAfterFeedbackRequest(session, feedbackRequest) {
  const requestMs = dateMsOrNull(feedbackRequest?.requested_at)
  const activityMs = dateMsOrNull(session?.last_activity_at || session?.updated_at)
  return requestMs != null && activityMs != null && activityMs > requestMs
}

function rubricKeyAliases(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return []
  return [
    normalized,
    normalized.replace(/[\s:_-]+/g, ''),
    normalized.replace(/_/g, ':'),
    normalized.replace(/:/g, '_'),
  ].filter((alias, index, aliases) => alias && aliases.indexOf(alias) === index)
}

function normalizedRubricScoresForAssignment(scores = {}, assignment = null) {
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  if (!rubric.length || !scores || typeof scores !== 'object') {
    return scores && typeof scores === 'object' ? { ...scores } : {}
  }
  const incoming = new Map()
  for (const [key, value] of Object.entries(scores)) {
    for (const alias of rubricKeyAliases(key)) {
      if (!incoming.has(alias)) incoming.set(alias, value)
    }
  }
  const normalized = {}
  for (const criterion of rubric) {
    const score = rubricKeyAliases(criterion.id || criterion.title)
      .map((alias) => incoming.get(alias))
      .find((value) => value !== undefined)
    if (score !== undefined) {
      normalized[criterion.id] = Number(score || 0)
    }
  }
  return normalized
}

function gradingPublishFields(body = {}, existing = {}) {
  const shouldPublish = body?.publish_feedback !== false
  const wasPublished = existing?.feedback_status !== 'draft' && gradingHasStudentVisibleFeedback(existing)
  return {
    feedback_status: shouldPublish ? 'published' : 'draft',
    published_at: shouldPublish ? nowIso() : (wasPublished ? existing.published_at || null : null),
  }
}

function feedbackAnnotationResolveKey(annotation = {}) {
  const explicitId = String(annotation?.id || '').trim()
  if (explicitId) {
    return `id:${explicitId}`
  }
  return [
    'inline',
    annotation?.type === 'suggestion' ? 'suggestion' : 'comment',
    Math.max(0, Number(annotation?.originalStart ?? annotation?.original_start ?? annotation?.start ?? 0) || 0),
    Math.max(0, Number(annotation?.originalEnd ?? annotation?.original_end ?? annotation?.end ?? annotation?.start ?? 0) || 0),
    String(annotation?.quote || '').trim(),
    String(annotation?.note || '').trim(),
    String(annotation?.replacement || '').trim(),
  ].join(':')
}

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
    tenant_id: session.tenant_id,
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

function textSnapshotMetadata(text) {
  const value = String(text || '')
  return {
    current_text_length: value.length,
    current_text_hash: createHash('sha256').update(value).digest('hex'),
  }
}

function shouldInlineLiveReplayText(text) {
  return String(text || '').length <= LIVE_REPLAY_INLINE_TEXT_LIMIT
}

function buildLiveReplayResponse(head, events = [], replay = null) {
  const textMetadata = textSnapshotMetadata(head.current_text)
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
    ...textMetadata,
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

function replayFromLiveSessionFallback(replayId, liveSession) {
  return buildEduReplay({
    id: replayId,
    live_session_id: liveSession.id,
    assignment_id: liveSession.assignment_id,
    assignment_title: liveSession.assignment_title,
    course: liveSession.course,
    classroom: liveSession.classroom,
    student_name: liveSession.student_name,
    current_text: liveSession.current_text,
    document_history: liveSession.document_history,
    keystroke_log: liveSession.keystroke_log,
    focus_events: liveSession.focus_events,
    url_history: liveSession.url_history,
    violations: liveSession.violations,
    last_activity_at: liveSession.last_activity_at,
    focused: liveSession.focused,
    hid_active: liveSession.hid_active,
  })
}

async function appendLiveReplayUpdate(eduStore, session, replay = null) {
  const existingHead = await eduStore.getLiveReplayHead(session.id)
  const previousHistoryCount = Number(existingHead?.snapshot_history_count ?? 0)
  const previousUrlHistoryCount = Number(existingHead?.snapshot_url_history_count ?? 0)
  const history = Array.isArray(session.document_history) ? session.document_history : []
  const urlHistory = Array.isArray(session.url_history) ? session.url_history : []
  const documentHistoryTail = history.slice(Math.max(0, previousHistoryCount))
  const urlHistoryTail = urlHistory.slice(Math.max(0, previousUrlHistoryCount))
  const textChanged = String(existingHead?.current_text || '') !== String(session.current_text || '')

  const hasMeaningfulChange =
    !existingHead ||
    documentHistoryTail.length > 0 ||
    urlHistoryTail.length > 0 ||
    textChanged ||
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
    tenant_id: session.tenant_id,
    live_session_id: session.id,
    replay_session_id: head.replay_session_id,
    assignment_id: session.assignment_id,
    student_name: session.student_name,
    seq: nextSeq,
    ...(textChanged && (!documentHistoryTail.length || shouldInlineLiveReplayText(session.current_text))
      ? { current_text: session.current_text }
      : {}),
    ...textSnapshotMetadata(session.current_text),
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

  const classrooms = await store.listClassrooms(null)
  return (
    classrooms.find(
      (classroom) =>
        classroom.id !== excludeClassroomId &&
        String(classroom.join_code || '').trim().toUpperCase() === normalizedJoinCode,
    ) || null
  )
}

const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomJoinCode(length = 6) {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length]).join('')
}

async function resolveClassroomJoinCode(store, requestedJoinCode, excludeClassroomId = null) {
  const requested = String(requestedJoinCode || '').trim()
  if (requested) {
    return requested.toUpperCase()
  }

  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = randomJoinCode()
    if (!(await findJoinCodeConflict(store, candidate, excludeClassroomId))) {
      return candidate
    }
  }

  throw new Error('Could not generate an unused join code')
}

function normalizeEntityName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

async function findClassroomNameConflict(store, classroomName, excludeClassroomId = null, tenantId = DEFAULT_TENANT_ID) {
  const normalizedName = normalizeEntityName(classroomName)
  if (!normalizedName) {
    return null
  }

  const classrooms = await store.listClassrooms(tenantId)
  return (
    classrooms.find(
      (classroom) =>
        classroom.id !== excludeClassroomId &&
        normalizeEntityName(classroom.name) === normalizedName,
    ) || null
  )
}

async function findAssignmentTitleConflict(store, assignmentTitle, excludeAssignmentId = null, tenantId = DEFAULT_TENANT_ID) {
  const normalizedTitle = normalizeEntityName(assignmentTitle)
  if (!normalizedTitle) {
    return null
  }

  const assignments = await store.listAssignments(tenantId)
  return (
    assignments.find(
      (assignment) =>
        assignment.id !== excludeAssignmentId &&
        normalizeEntityName(assignment.title) === normalizedTitle,
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
    res.json(await buildEduDashboard(eduStore, teacherTenantId(session)))
  })

  app.get('/api/edu/dashboard/updates', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    res.json(await buildEduDashboardDelta(eduStore, teacherTenantId(session), { since: req.query.since }))
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

  app.post('/api/edu/auth/signup', async (req, res) => {
    await ensureEduSeedData(eduStore)
    try {
      const teacher = await createTeacherAccount(eduStore, {
        name: req.body?.name,
        email: req.body?.email,
        password: req.body?.password,
      })
      const sessionRecord = await createTeacherSession(eduStore, teacher, 'password')
      res.setHeader('Set-Cookie', teacherSessionCookie(sessionRecord.id))
      res.status(201).json(
        await getTeacherSession(
          eduStore,
          `${req.headers.cookie || ''}; edu_teacher_session=${sessionRecord.id}`,
        ),
      )
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Could not create teacher account',
        authenticated: false,
      })
    }
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
    res.json(await eduStore.listClassrooms(teacherTenantId(session)))
  })

  app.post('/api/edu/classrooms', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const body = req.body || {}
    let joinCode = ''
    try {
      joinCode = await resolveClassroomJoinCode(eduStore, body.join_code)
    } catch (error) {
      return res.status(503).json({
        error: error instanceof Error ? error.message : 'Could not generate an unused join code',
      })
    }
    const classroom = buildClassroom({ ...body, tenant_id: teacherTenantId(session), join_code: joinCode })
    const conflict = await findJoinCodeConflict(eduStore, classroom.join_code)
    if (conflict) {
      return res.status(409).json({ error: 'Join code already in use', join_code: classroom.join_code })
    }
    const nameConflict = await findClassroomNameConflict(eduStore, classroom.name, null, classroom.tenant_id)
    if (nameConflict) {
      return res.status(409).json({ error: 'Classroom name already in use', name: classroom.name })
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
    if (!classroom || classroom.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.json(classroom)
  })

  app.put('/api/edu/classrooms/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const body = req.body || {}
    let joinCode = existing.join_code
    if (Object.prototype.hasOwnProperty.call(body, 'join_code')) {
      try {
        joinCode = await resolveClassroomJoinCode(eduStore, body.join_code, existing.id)
      } catch (error) {
        return res.status(503).json({
          error: error instanceof Error ? error.message : 'Could not generate an unused join code',
        })
      }
    }
    const classroom = buildClassroom({ ...existing, ...body, id: req.params.id, join_code: joinCode, updated_at: nowIso() })
    const conflict = await findJoinCodeConflict(eduStore, classroom.join_code, classroom.id)
    if (conflict) {
      return res.status(409).json({ error: 'Join code already in use', join_code: classroom.join_code })
    }
    const nameConflict = await findClassroomNameConflict(eduStore, classroom.name, classroom.id, classroom.tenant_id)
    if (nameConflict) {
      return res.status(409).json({ error: 'Classroom name already in use', name: classroom.name })
    }
    await eduStore.putClassroom(classroom)
    res.json(classroom)
  })

  app.post('/api/edu/classrooms/:id/students/rename', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    try {
      const classroom = await renameClassroomStudent(
        eduStore,
        existing,
        req.body?.old_name,
        req.body?.new_name,
      )
      res.json(classroom)
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename student' })
    }
  })

  app.delete('/api/edu/classrooms/:id/students/:studentName', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    try {
      const classroom = await removeClassroomStudent(eduStore, existing, req.params.studentName)
      res.json({ removed: true, classroom })
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove student' })
    }
  })

  app.delete('/api/edu/classrooms/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getClassroom(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const assignments = await eduStore.listAssignments(existing.tenant_id)
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
    res.json(await eduStore.listAssignments(teacherTenantId(session)))
  })

  app.post('/api/edu/assignments', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = buildAssignment({ ...(req.body || {}), tenant_id: teacherTenantId(session) })
    const titleConflict = await findAssignmentTitleConflict(eduStore, assignment.title, null, assignment.tenant_id)
    if (titleConflict) {
      return res.status(409).json({ error: 'Assignment title already in use', title: assignment.title })
    }
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
    if (!assignment || assignment.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const audits = (await eduStore.listAssignmentAudits(assignment.tenant_id)).filter(
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
    if (!assignment || assignment.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.json(assignment)
  })

  app.get('/api/edu/assignments/:id/live-summaries', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const assignment = await eduStore.getAssignment(req.params.id)
    if (!assignment || assignment.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
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

  app.post('/api/edu/assignments/:id/feedback-requests', async (req, res) => {
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
      student_feedback_requests: {
        ...(existing.student_feedback_requests || {}),
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
      student_feedback_request: updatedAssignment.student_feedback_requests?.[normalizedKey] || null,
    })
  })

  app.delete('/api/edu/assignments/:id/feedback-requests/:studentName', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getAssignment(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const studentName = String(req.params.studentName || '').trim()
    if (!studentName) {
      return res.status(400).json({ error: 'Student name is required' })
    }
    const hadRequest = Boolean(studentFeedbackRequestForStudent(existing, studentName))
    const updatedAssignment = hadRequest
      ? buildAssignment({
          ...existing,
          student_feedback_requests: studentFeedbackRequestsAfterFeedback(existing, studentName),
          updated_at: nowIso(),
        })
      : existing
    if (hadRequest) {
      await eduStore.putAssignment(updatedAssignment)
      await eduStore.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'updated',
          assignment: updatedAssignment,
          previousAssignment: existing,
          actor: session,
        }),
      )
    }
    res.json({
      assignment_id: updatedAssignment.id,
      assignment: updatedAssignment,
      dismissed: hadRequest,
      student_name: studentName,
      student_feedback_request: null,
    })
  })

  app.put('/api/edu/assignments/:id', async (req, res) => {
    const session = await getTeacherSession(eduStore, req.headers.cookie)
    if (!session.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const existing = await eduStore.getAssignment(req.params.id)
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const input = req.body || {}
    const builtAssignment = buildAssignment({ ...existing, ...input, id: req.params.id, updated_at: nowIso() })
    const assignment = assignmentTimingFieldsChanged(input)
      ? assignmentWithRejoinHistoryReset(builtAssignment)
      : builtAssignment
    const titleConflict = await findAssignmentTitleConflict(eduStore, assignment.title, assignment.id, assignment.tenant_id)
    if (titleConflict) {
      return res.status(409).json({ error: 'Assignment title already in use', title: assignment.title })
    }
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
    if (!existing || existing.tenant_id !== teacherTenantId(session)) {
      return res.status(404).json({ error: 'Not found' })
    }
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
    res.json((await eduStore.listLiveSessions(teacherTenantId(session))).map((item) => buildLiveSession(item)))
  })

  app.post('/api/edu/live-sessions', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const nextId =
      req.body?.id ||
      `${req.body?.student_name || 'student'}:${req.body?.assignment_id || 'assignment'}`
    const existing = await eduStore.getLiveSession(nextId)
    let assignment = req.body?.assignment_id ? await eduStore.getAssignment(req.body.assignment_id) : null
    const draftMerge = mergeLiveSessionDraft(req.body || {}, existing || {})
    if (draftMerge.error) {
      return res.status(draftMerge.error.status).json(draftMerge.error.body)
    }
    const session = buildLiveSession({
      ...existing,
      ...(req.body || {}),
      tenant_id: existing?.tenant_id || assignment?.tenant_id || req.body?.tenant_id,
      id: nextId,
      current_text: draftMerge.session.current_text,
      document_history: draftMerge.session.document_history,
      grading:
        req.body?.grading && typeof req.body.grading === 'object'
          ? req.body.grading
          : existing?.grading,
      updated_at: nowIso(),
    })
    await eduStore.putLiveSession(session)
    const feedbackRequest = studentFeedbackRequestForStudent(assignment, session.student_name)
    if (assignment && liveSessionActivityIsAfterFeedbackRequest(session, feedbackRequest)) {
      assignment = buildAssignment({
        ...assignment,
        student_feedback_requests: studentFeedbackRequestsAfterFeedback(assignment, session.student_name),
        updated_at: nowIso(),
      })
      await eduStore.putAssignment(assignment)
    }
    await appendLiveReplayUpdate(eduStore, session)
    res.status(201).json({ ...session, ...draftMerge.ack })
  })

  app.get('/api/edu/live-sessions/:id', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    const liveSession = await eduStore.getLiveSession(req.params.id)
    if (!liveSession || liveSession.tenant_id !== teacherTenantId(teacherSession)) {
      return res.status(404).json({ error: 'Not found' })
    }
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
      if (head.tenant_id !== teacherTenantId(teacherSession)) {
        return res.status(404).json({ error: 'Not found' })
      }
      const replay = head.replay_session_id ? await eduStore.getReplay(head.replay_session_id) : null
      return res.json(buildLiveReplayResponse(head, await eduStore.listLiveReplayEvents(head.id, head.tenant_id), replay))
    }

    const liveSession = await eduStore.getLiveSession(req.params.id)
    if (!liveSession || liveSession.tenant_id !== teacherTenantId(teacherSession)) {
      return res.status(404).json({ error: 'Not found' })
    }
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
    if (!head || head.tenant_id !== teacherTenantId(teacherSession)) {
      return res.status(404).json({ error: 'Not found' })
    }
    const sinceSeq = Math.max(0, Number(req.query.since_seq ?? 0) || 0)
    const events = (await eduStore.listLiveReplayEvents(head.id, head.tenant_id)).filter((event) => event.seq > sinceSeq)
    const replay = head.replay_session_id ? await eduStore.getReplay(head.replay_session_id) : null
    res.json({
      id: head.id,
      live_session_id: head.live_session_id || head.id,
      replay_session_id: head.replay_session_id || replay?.id || null,
      ...(shouldInlineLiveReplayText(head.current_text) ? { current_text: head.current_text } : {}),
      ...textSnapshotMetadata(head.current_text),
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
    let existing = await eduStore.getLiveSession(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const assignment = existing.assignment_id ? await eduStore.getAssignment(existing.assignment_id) : null
    if (
      assignment?.tenant_id &&
      teacherSession.tenant_id &&
      existing.tenant_id !== teacherSession.tenant_id &&
      assignment.tenant_id === teacherSession.tenant_id
    ) {
      existing = buildLiveSession({ ...existing, tenant_id: assignment.tenant_id })
    }

    const publishFields = gradingPublishFields(req.body, existing?.grading)
    let grading = {
      rubric_scores:
        req.body?.rubric_scores && typeof req.body.rubric_scores === 'object'
          ? normalizedRubricScoresForAssignment(req.body.rubric_scores, assignment)
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
      ...publishFields,
      actor_id: teacherSession.teacher_id || null,
      actor_name: teacherSession.teacher_name || null,
      actor_email: teacherSession.teacher_email || null,
    }
    if (
      gradingHasStudentVisibleFeedback(existing?.grading) &&
      !gradingHasStudentVisibleFeedback(grading) &&
      req.body?.allow_empty_feedback !== true
    ) {
      grading = {
        ...existing.grading,
        updated_at: nowIso(),
        actor_id: teacherSession.teacher_id || existing.grading.actor_id || null,
        actor_name: teacherSession.teacher_name || existing.grading.actor_name || null,
        actor_email: teacherSession.teacher_email || existing.grading.actor_email || null,
      }
    }
    const updated = buildLiveSession({
      ...existing,
      grading,
      updated_at: nowIso(),
    })
    await eduStore.putLiveSession(updated)
    if (assignment && grading.feedback_status === 'published' && gradingHasStudentVisibleFeedback(grading)) {
      const updatedAssignment = buildAssignment({
        ...assignment,
        student_feedback_requests: studentFeedbackRequestsAfterFeedback(assignment, updated.student_name),
        updated_at: nowIso(),
      })
      await eduStore.putAssignment(updatedAssignment)
      await eduStore.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'updated',
          assignment: updatedAssignment,
          previousAssignment: assignment,
          actor: teacherSession,
        }),
      )
    }
    res.json(updated)
  })

  app.delete('/api/edu/live-sessions/:id/grading', async (req, res) => {
    const teacherSession = await getTeacherSession(eduStore, req.headers.cookie)
    if (!teacherSession.authenticated) {
      return res.status(401).json({ error: 'Unauthorized', authenticated: false })
    }
    await ensureEduSeedData(eduStore)
    let existing = await eduStore.getLiveSession(req.params.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const assignment = existing.assignment_id ? await eduStore.getAssignment(existing.assignment_id) : null
    if (
      assignment?.tenant_id &&
      teacherSession.tenant_id &&
      existing.tenant_id !== teacherSession.tenant_id &&
      assignment.tenant_id === teacherSession.tenant_id
    ) {
      existing = buildLiveSession({ ...existing, tenant_id: assignment.tenant_id })
    }
    if (existing.tenant_id !== teacherTenantId(teacherSession)) {
      return res.status(404).json({ error: 'Not found' })
    }

    const updatedAt = nowIso()
    const updated = buildLiveSession({
      ...existing,
      grading: {
        rubric_scores: {},
        teacher_comment: '',
        returned_for_revision: false,
        grade_label: '',
        grade_score: null,
        inline_annotations: [],
        feedback_status: 'draft',
        published_at: null,
        updated_at: updatedAt,
        actor_id: teacherSession.teacher_id || null,
        actor_name: teacherSession.teacher_name || null,
        actor_email: teacherSession.teacher_email || null,
      },
      updated_at: updatedAt,
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
    let replay = await eduStore.getReplay(req.params.id)
    if (!replay) {
      const liveSessionId = req.params.id.replace(/^replay:/, '')
      const liveSession = await eduStore.getLiveSession(liveSessionId)
      if (liveSession) {
        replay = replayFromLiveSessionFallback(req.params.id, liveSession)
      }
    }
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
    const result = await buildStudentConfig(eduStore, {
      joinCode: req.query.join_code || '',
      studentName: req.query.student_name || '',
      joining: req.query.joining === '1',
    })
    if (result.duplicate_student_name) {
      return res.status(409).json({ error: 'A student with that name has already joined this class.' })
    }
    res.json(result)
  })

  app.get('/api/edu/student/assignments/:id', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const studentName = String(req.query.student_name || '').trim()
    const result = await buildStudentActiveAssignmentState(eduStore, {
      assignmentId: req.params.id,
      joinCode: req.query.join_code || '',
      studentName,
    })
    if (!result.classroom || !result.assignment) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.json(result)
  })

  app.post('/api/edu/student/assignments/:id/open', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const studentName = String(req.body?.student_name || '').trim()
    const joinCode = String(req.body?.join_code || '').trim()
    const result = await buildStudentAssignmentConfig(eduStore, {
      assignmentId: req.params.id,
      joinCode,
      studentName,
    })
    if (!result.classroom || !result.assignment || !studentName) {
      return res.status(404).json({ error: 'Not found' })
    }
    const existing = await eduStore.getAssignment(result.assignment.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })
    const openedAt = new Date()
    const openResult = recordStudentAssignmentOpen(existing, studentName, openedAt)
    if (openResult.assignment.updated_at !== existing.updated_at || openResult.recorded) {
      await eduStore.putAssignment(openResult.assignment)
    }
    await eduStore.putAssignmentAudit(
      {
        tenant_id: openResult.assignment.tenant_id,
        assignment_id: openResult.assignment.id,
        classroom_id: openResult.assignment.classroom_id,
        assignment_title: openResult.assignment.title,
        action: 'student_opened',
        actor_id: null,
        actor_name: null,
        actor_email: null,
        summary: `${studentName} opened the assignment`,
        changes: [{ label: 'Student assignment open', before: null, after: studentName }],
        snapshot: openResult.assignment,
        created_at: openedAt.toISOString(),
        updated_at: openedAt.toISOString(),
      },
    )
    res.status(201).json({
      recorded: true,
      assignment_id: openResult.assignment.id,
      student_name: studentName,
      access_revoked: openResult.access_revoked,
      close_count: openResult.close_count,
    })
  })

  app.post('/api/edu/student/assignments/:id/feedback-resolutions', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const studentName = String(req.body?.student_name || '').trim()
    const joinCode = String(req.body?.join_code || '').trim()
    const annotationKey = String(req.body?.annotation_key || '').trim()
    const result = await buildStudentAssignmentConfig(eduStore, {
      assignmentId: req.params.id,
      joinCode,
      studentName,
    })
    if (!result.classroom || !result.assignment || !studentName) {
      return res.status(404).json({ error: 'Not found' })
    }
    if (!annotationKey) {
      return res.status(400).json({ error: 'Annotation key is required' })
    }

    const session = await eduStore.getLiveSessionForAssignmentStudent(
      req.params.id,
      studentName,
      result.assignment.tenant_id,
    )
    if (!session?.grading?.inline_annotations?.length) {
      return res.status(404).json({ error: 'Feedback annotation not found' })
    }
    const resolvedAt = nowIso()
    let matched = false
    const inlineAnnotations = session.grading.inline_annotations.map((annotation) => {
      if (feedbackAnnotationResolveKey(annotation) !== annotationKey) {
        return annotation
      }
      matched = true
      return {
        ...annotation,
        resolved_by_student: true,
        resolved_at: annotation.resolved_at || resolvedAt,
        resolved_by: studentName,
        updated_at: resolvedAt,
      }
    })
    if (!matched) {
      return res.status(404).json({ error: 'Feedback annotation not found' })
    }
    const grading = {
      ...session.grading,
      inline_annotations: inlineAnnotations,
      updated_at: resolvedAt,
    }
    const updatedSession = buildLiveSession({
      ...session,
      grading,
      updated_at: resolvedAt,
    })
    await eduStore.putLiveSession(updatedSession)
    res.json({ ok: true, annotation_key: annotationKey, resolved_at: resolvedAt })
  })

  app.post('/api/edu/student/assignments/:id/close', async (req, res) => {
    await ensureEduSeedData(eduStore)
    const studentName = String(req.body?.student_name || '').trim()
    const joinCode = String(req.body?.join_code || '').trim()
    const result = await buildStudentAssignmentConfig(eduStore, {
      assignmentId: req.params.id,
      joinCode,
      studentName,
    })
    if (!result.classroom || !result.assignment || !studentName) {
      return res.status(404).json({ error: 'Not found' })
    }

    const existing = await eduStore.getAssignment(result.assignment.id)
    if (!existing) return res.status(404).json({ error: 'Not found' })

    const closedAt = new Date()
    const closeResult = recordStudentAssignmentClose(existing, studentName, closedAt)
    const updatedAssignment = closeResult.assignment

    if (updatedAssignment.updated_at !== existing.updated_at || closeResult.history) {
      await eduStore.putAssignment(updatedAssignment)
    }
    await eduStore.putAssignmentAudit(
      {
        tenant_id: updatedAssignment.tenant_id,
        assignment_id: updatedAssignment.id,
        classroom_id: updatedAssignment.classroom_id,
        assignment_title: updatedAssignment.title,
        action: 'student_closed',
        actor_id: null,
        actor_name: null,
        actor_email: null,
        summary: closeResult.access_revoked
          ? `${studentName} left twice and now needs approval to return`
          : `${studentName} left the assignment`,
        changes: [
          {
            label: closeResult.access_revoked ? 'Student re-entry approval required' : 'Student assignment close',
            before: null,
            after: studentName,
          },
        ],
        snapshot: updatedAssignment,
        created_at: closedAt.toISOString(),
        updated_at: closedAt.toISOString(),
      },
    )
    res.status(201).json({
      recorded: true,
      assignment_id: updatedAssignment.id,
      student_name: studentName,
      access_revoked: closeResult.access_revoked,
      close_count: closeResult.close_count,
    })
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
