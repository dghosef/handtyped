import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'
import {
  buildAssignmentChannel,
  buildReplayChannel,
  buildStudentAssignmentChannel,
  buildStudentAssignmentGroupChannel,
  buildStudentBootstrapChannel,
  buildTenantChannel,
  EduRealtimeHub,
  publishRealtimeEvent,
} from './edu-realtime.js'
import {
  buildAssignmentLiveSummaries,
  buildAssignmentAuditRecord,
  buildEduDashboard,
  buildEduDashboardDelta,
  scheduleStateForAssignment,
  buildStudentActiveAssignmentState,
  buildStudentAssignmentConfig,
  buildStudentConfig,
  createD1EduStore,
  createKvEduStore,
  ensureEduSeedData,
  removeClassroomStudent,
  renameClassroomStudent,
} from './edu-store.js'
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
  authenticateTeacher,
  authenticateTeacherWithGoogle,
  clearTeacherSessionCookie,
  createTeacherAccount,
  createTeacherSession,
  destroyTeacherSession,
  getTeacherSession,
  teacherSessionCookie,
} from './edu-auth.js'
import { verifyGoogleIdToken } from './edu-google-auth.js'

const RESERVED_REPLAY_ROOTS = new Set(['api', 'replay'])
const REPLAY_HOSTS = new Set(['replay.handtyped.app'])
const EDU_HOSTS = new Set(['edu.handtyped.app'])
let guardrailsState = null
let guardrailsStateKey = ''
const LIVE_SESSION_STALE_MS = 15000

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  })
}

function lastPathSegment(pathname = '') {
  const segment = String(pathname || '').split('/').pop() || ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function pathSegment(pathname = '', index = 0) {
  const segment = String(pathname || '').split('/')[index] || ''
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? null : parsed
}

function sessionPresenceTimestamp(session) {
  const lastActivityAt = parseTimestamp(session?.last_activity_at)
  const updatedAt = parseTimestamp(session?.updated_at)
  return Math.max(lastActivityAt || 0, updatedAt || 0) || null
}

function isLiveSessionActive(session, nowMs = Date.now()) {
  if (!session?.schedule_open) {
    return false
  }
  const presenceAt = sessionPresenceTimestamp(session)
  if (!presenceAt) {
    return false
  }
  return nowMs - presenceAt <= LIVE_SESSION_STALE_MS
}

function normalizedSuggestionAnnotation(annotation = {}) {
  const type = annotation?.type === 'suggestion' ? 'suggestion' : 'comment'
  if (type !== 'suggestion') {
    return null
  }
  const start = Math.max(0, Number(annotation?.start ?? 0) || 0)
  const end = Math.max(start, Number(annotation?.end ?? start) || start)
  return JSON.stringify({
    type,
    start,
    end,
    quote: String(annotation?.quote || ''),
    note: String(annotation?.note || ''),
    replacement: String(annotation?.replacement || ''),
  })
}

function suggestionsIntroduceUnsafeChanges(existingAnnotations = [], incomingAnnotations = []) {
  const existingSet = new Set(
    (Array.isArray(existingAnnotations) ? existingAnnotations : [])
      .map(normalizedSuggestionAnnotation)
      .filter(Boolean),
  )

  return (Array.isArray(incomingAnnotations) ? incomingAnnotations : [])
    .map(normalizedSuggestionAnnotation)
    .filter(Boolean)
    .some((serialized) => !existingSet.has(serialized))
}

function canSafelySubmitSuggestions(session, assignment, now = new Date()) {
  if (!session || !assignment) {
    return false
  }
  if (assignment?.policy?.allow_offline_editing !== false) {
    return false
  }

  const schedule = scheduleStateForAssignment(assignment, session.student_name, now)
  if (!schedule.schedule_open) {
    return true
  }

  return !isLiveSessionActive(session, now.getTime())
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

async function liveSessionFromGradingSnapshot(store, sessionId, body = {}, teacherTenant = DEFAULT_TENANT_ID) {
  const snapshot = body?.session_snapshot && typeof body.session_snapshot === 'object' ? body.session_snapshot : null
  if (!snapshot) {
    return null
  }
  const assignmentId = String(snapshot.assignment_id || '')
  const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
  if (!assignment || assignment.tenant_id !== teacherTenant) {
    return null
  }
  return buildLiveSession({
    ...snapshot,
    id: snapshot.id || sessionId,
    tenant_id: assignment.tenant_id,
    assignment_id: assignment.id,
    assignment_title: snapshot.assignment_title || assignment.title,
    course: snapshot.course || assignment.course,
    classroom: snapshot.classroom || assignment.classroom_name,
  })
}

async function resolveLiveSessionForGrading(store, sessionId) {
  if (!sessionId) {
    return null
  }
  const liveSession = await store.getLiveSession(sessionId)
  if (liveSession) {
    return liveSession
  }
  const replayId = String(sessionId).startsWith('replay:') ? String(sessionId).replace(/^replay:/, '') : ''
  if (replayId) {
    const replayLiveSession = await store.getLiveSession(replayId)
    if (replayLiveSession) {
      return replayLiveSession
    }
  }
  const head =
    (await store.getLiveReplayHead?.(sessionId)) ||
    (replayId ? await store.getLiveReplayHead?.(replayId) : null)
  if (!head) {
    return null
  }
  const headLiveSession =
    (head.live_session_id ? await store.getLiveSession(head.live_session_id) : null) ||
    (head.id ? await store.getLiveSession(head.id) : null)
  if (headLiveSession) {
    return headLiveSession
  }
  return buildLiveSession({
    ...head,
    id: head.live_session_id || head.id,
    schedule_open: false,
  })
}

async function serveReplayHtml(request, env) {
  return env.ASSETS.fetch(new URL('/replay.html', request.url))
}

async function serveEduReplayHtml(request, env) {
  return env.ASSETS.fetch(new URL('/edu/replay.html', request.url))
}

async function serveEduHtml(request, env) {
  return env.ASSETS.fetch(new URL('/edu/index.html', request.url))
}

async function serveEduAppHtml(request, env) {
  return env.ASSETS.fetch(new URL('/edu/app.html', request.url))
}

async function serveEduLoginHtml(request, env) {
  return env.ASSETS.fetch(new URL('/edu/login.html', request.url))
}

async function serveUnsignedWindowsHtml(request, env) {
  return env.ASSETS.fetch(new URL('/unsigned-windows.html', request.url))
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

function isEduHost(hostname) {
  return EDU_HOSTS.has(hostname)
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

function getEduStore(env) {
  if (env.EDU_DB) {
    return createD1EduStore(env.EDU_DB)
  }
  return createKvEduStore(env.SESSIONS)
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

async function appendLiveReplayUpdate(store, session, replay = null) {
  const existingHead = await store.getLiveReplayHead(session.id)
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
  await store.putLiveReplayHead(head)
  if (!hasMeaningfulChange) {
    return head
  }
  await store.appendLiveReplayEvent(
    buildLiveReplayEvent({
      id: `${session.id}:${String(nextSeq).padStart(8, '0')}`,
      tenant_id: session.tenant_id,
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
    }),
  )
  return head
}

function getEduAuthStore(env) {
  return createKvEduStore(env.SESSIONS)
}

async function prepareEduStore(store) {
  await ensureEduSeedData(store)
  await store.runMaintenance?.()
  return store
}

async function runScheduledEduMaintenance(env) {
  const store = getEduStore(env)
  await ensureEduSeedData(store)
  await store.runMaintenance?.({ force: true })
}

function teacherTenantId(session) {
  return session?.tenant_id || DEFAULT_TENANT_ID
}

function maybeAuthSession(session) {
  return session?.authenticated ? session : null
}

async function publishTeacherDashboard(env, tenantId) {
  const store = getEduStore(env)
  const payload = await buildEduDashboardDelta(store, tenantId, { since: '' })
  await publishRealtimeEvent(env, {
    channels: [buildTenantChannel(tenantId, 'dashboard')],
    event: 'dashboard',
    payload,
  })
}

async function publishTeacherDashboardLiveSession(env, session) {
  if (!session?.tenant_id) {
    return
  }
  const store = getEduStore(env)
  const summary =
    (await store.getDashboardSummary?.(session.tenant_id)) ||
    (await store.refreshDashboardSummary?.(session.tenant_id))
  await publishRealtimeEvent(env, {
    channels: [buildTenantChannel(session.tenant_id, 'dashboard')],
    event: 'dashboard',
    payload: {
      updated_at: summary?.updated_at || session.updated_at || nowIso(),
      live_sessions: [session],
      summary,
    },
  })
}

async function publishAssignmentLiveSession(env, session) {
  if (!session?.tenant_id || !session?.assignment_id) {
    return
  }
  await publishRealtimeEvent(env, {
    channels: [buildAssignmentChannel(session.tenant_id, session.assignment_id)],
    event: 'assignment',
    payload: {
      live_sessions: [session],
      updated_at: session.updated_at || nowIso(),
    },
  })
}

async function publishAssignmentSummary(env, assignmentId, tenantId, { includeAudits = true } = {}) {
  const store = getEduStore(env)
  const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
  if (!assignment) {
    return
  }
  const payload = {
    assignment,
    live_sessions: await buildAssignmentLiveSummaries(store, assignmentId),
    updated_at: nowIso(),
  }
  if (includeAudits) {
    payload.assignment_audits = await store.listAssignmentAuditsByAssignmentId(assignmentId, tenantId)
  }
  await publishRealtimeEvent(env, {
    channels: [buildAssignmentChannel(tenantId, assignmentId)],
    event: 'assignment',
    payload,
  })
}

async function publishStudentAccessRequest(env, assignment, requestKey, requestEntry) {
  if (!assignment?.tenant_id || !assignment?.id || !requestKey || !requestEntry) {
    return
  }
  await publishRealtimeEvent(env, {
    channels: [
      buildTenantChannel(assignment.tenant_id, 'dashboard'),
      buildAssignmentChannel(assignment.tenant_id, assignment.id),
    ],
    event: 'access-request',
    payload: {
      assignment_id: assignment.id,
      assignment,
      request_key: requestKey,
      student_access_request: requestEntry,
      updated_at: assignment.updated_at || nowIso(),
    },
  })
}

async function publishReplayUpdate(env, liveSessionId, tenantId) {
  const store = getEduStore(env)
  const head = liveSessionId ? await store.getLiveReplayHead(liveSessionId) : null
  if (!head) {
    return
  }
  const replay = head.replay_session_id ? await store.getReplay(head.replay_session_id) : null
  const events = await store.listLiveReplayEvents(head.id, tenantId)
  await publishRealtimeEvent(env, {
    channels: [buildReplayChannel(tenantId, liveSessionId)],
    event: 'replay',
    payload: buildLiveReplayResponse(head, events, replay),
  })
}

async function publishStudentAssignment(env, assignment, studentName, joinCode) {
  if (!assignment || !studentName || !joinCode) {
    return
  }
  const store = getEduStore(env)
  const result = await buildStudentActiveAssignmentState(store, {
    assignmentId: assignment.id,
    joinCode,
    studentName,
  })
  if (!result.assignment || !result.classroom) {
    return
  }
  await publishRealtimeEvent(env, {
    channels: [
      buildStudentAssignmentChannel({
        tenantId: result.assignment.tenant_id,
        classroomId: result.assignment.classroom_id,
        assignmentId: result.assignment.id,
        studentKey: String(studentName || '').trim().toLowerCase(),
      }),
    ],
    event: 'student-assignment',
    payload: {
      ...result,
      updated_at: nowIso(),
    },
  })
}

async function publishStudentAssignmentInvalidation(env, assignment, { deleted = false } = {}) {
  if (!assignment) {
    return
  }
  await publishRealtimeEvent(env, {
    channels: [
      buildStudentAssignmentGroupChannel({
        tenantId: assignment.tenant_id,
        classroomId: assignment.classroom_id,
        assignmentId: assignment.id,
      }),
    ],
    event: 'student-assignment-invalidated',
    payload: {
      assignment_id: assignment.id,
      deleted: Boolean(deleted),
      updated_at: nowIso(),
    },
  })
}

async function publishStudentBootstrapInvalidation(env, subject, { reason = 'changed', assignmentId = '' } = {}) {
  const tenantId = subject?.tenant_id
  const classroomId = subject?.classroom_id || subject?.id
  if (!tenantId || !classroomId) {
    return
  }
  await publishRealtimeEvent(env, {
    channels: [
      buildStudentBootstrapChannel({
        tenantId,
        classroomId,
      }),
    ],
    event: 'student-bootstrap-invalidated',
    payload: {
      classroom_id: classroomId,
      assignment_id: assignmentId || subject?.assignment_id || '',
      reason,
      updated_at: nowIso(),
    },
  })
}

async function safeList(load, fallback = []) {
  try {
    const result = await load()
    return Array.isArray(result) ? result : fallback
  } catch {
    return fallback
  }
}

async function buildSafeEduDashboard(store) {
  const classrooms = await safeList(() => store.listClassrooms())
  const assignments = await safeList(() => store.listAssignments())
  const live_sessions = (await safeList(() => store.listLiveSessions())).map((item) =>
    buildLiveSession(item),
  )
  const replays = await safeList(() => store.listReplays())
  const assignment_audits = await safeList(() => store.listAssignmentAudits())

  return {
    updated_at: nowIso(),
    product: {
      host: 'edu.handtyped.app',
      teacher_surface: 'web',
      student_surface: 'native',
      student_runtime: 'native-app',
    },
    summary: {
      classrooms: classrooms.length,
      assignments: assignments.length,
      live_sessions: live_sessions.length,
      replays_available: replays.length,
      audits_recorded: assignment_audits.length,
    },
    classrooms,
    assignments,
    live_sessions,
    assignment_audits,
    architecture: {
      teacher_web_origin: 'https://edu.handtyped.app',
      replay_origin: 'https://replay.handtyped.app',
      student_delivery: 'native desktop app',
    },
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

function eduGoogleConfig(env) {
  return {
    enabled: Boolean(String(env.EDU_GOOGLE_CLIENT_ID || '').trim()),
    client_id: String(env.EDU_GOOGLE_CLIENT_ID || '').trim(),
    hosted_domain: String(env.EDU_GOOGLE_HOSTED_DOMAIN || '').trim(),
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const replayHost = isReplayHost(url.hostname)
    const eduHost = isEduHost(url.hostname)
    const guardrails = getGuardrails(env)

    if (replayHost && url.pathname === '/') {
      return notFound()
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/') {
      return serveEduHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/app') {
      return serveEduAppHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/login') {
      return serveEduLoginHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/unsigned-windows') {
      return serveUnsignedWindowsHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && /^\/edu\/replay\/[^/]+$/.test(url.pathname)) {
      return serveEduReplayHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/dashboard') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await buildEduDashboard(store, teacherTenantId(session)))
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/dashboard/updates') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await buildEduDashboardDelta(store, teacherTenantId(session), { since: url.searchParams.get('since') || '' }))
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/realtime') {
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated || !env.EDU_REALTIME) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const tenantId = teacherTenantId(session)
      const requested = url.searchParams.getAll('channel')
      const allowedPrefix = `tenant:${tenantId}:`
      const allowed = requested.filter((channel) => String(channel || '').startsWith(allowedPrefix))
      if (!allowed.length) {
        allowed.push(buildTenantChannel(tenantId, 'dashboard'))
      }
      const hubUrl = new URL('https://edu-realtime.internal/subscribe')
      for (const channel of allowed) {
        hubUrl.searchParams.append('channel', channel)
      }
      const id = env.EDU_REALTIME.idFromName('tenant-realtime-hub')
      return env.EDU_REALTIME.get(id).fetch(hubUrl)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/student/realtime') {
      if (!env.EDU_REALTIME) {
        return new Response('Realtime unavailable', { status: 503 })
      }
      const store = await prepareEduStore(getEduStore(env))
      const assignmentId = url.searchParams.get('assignment_id') || ''
      const studentName = url.searchParams.get('student_name') || ''
      const joinCode = url.searchParams.get('join_code') || ''
      const result = await buildStudentAssignmentConfig(store, { assignmentId, joinCode, studentName })
      if (!result.classroom || !result.assignment) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const personalChannel = buildStudentAssignmentChannel({
        tenantId: result.assignment.tenant_id,
        classroomId: result.assignment.classroom_id,
        assignmentId: result.assignment.id,
        studentKey: studentName.trim().toLowerCase(),
      })
      const groupChannel = buildStudentAssignmentGroupChannel({
        tenantId: result.assignment.tenant_id,
        classroomId: result.assignment.classroom_id,
        assignmentId: result.assignment.id,
      })
      const hubUrl = new URL('https://edu-realtime.internal/subscribe')
      hubUrl.searchParams.append('channel', personalChannel)
      hubUrl.searchParams.append('channel', groupChannel)
      const id = env.EDU_REALTIME.idFromName('tenant-realtime-hub')
      return env.EDU_REALTIME.get(id).fetch(hubUrl)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/student/bootstrap/realtime') {
      if (!env.EDU_REALTIME) {
        return new Response('Realtime unavailable', { status: 503 })
      }
      const store = await prepareEduStore(getEduStore(env))
      const result = await buildStudentConfig(store, {
        joinCode: url.searchParams.get('join_code') || '',
        studentName: url.searchParams.get('student_name') || '',
      })
      if (!result.classroom) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const hubUrl = new URL('https://edu-realtime.internal/subscribe')
      hubUrl.searchParams.append(
        'channel',
        buildStudentBootstrapChannel({
          tenantId: result.classroom.tenant_id,
          classroomId: result.classroom.id,
        }),
      )
      const id = env.EDU_REALTIME.idFromName('tenant-realtime-hub')
      return env.EDU_REALTIME.get(id).fetch(hubUrl)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/config') {
      const google = eduGoogleConfig(env)
      return json({
        host: 'edu.handtyped.app',
        teacher_surface: 'web',
        student_surface: 'native',
        replay_origin: 'https://replay.handtyped.app',
        auth: {
          password_enabled: true,
          google_enabled: google.enabled,
          google_client_id: google.client_id,
          google_hosted_domain: google.hosted_domain,
        },
      })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/auth/session') {
      return json(await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie')))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/auth/login') {
      const authStore = getEduAuthStore(env)
      const body = await parseJsonRequest(request)
      let teacher = null
      let providerName = String(body?.provider || '').trim() || 'password'

      if (providerName === 'google') {
        const google = eduGoogleConfig(env)
        const profile = await verifyGoogleIdToken({
          credential: body?.credential,
          clientId: google.client_id,
          hostedDomain: google.hosted_domain,
          mockVerifier: env.__googleTokenVerifier || null,
        }).catch(() => null)

        await prepareEduStore(getEduStore(env))
        teacher = profile
          ? await authenticateTeacherWithGoogle(getEduStore(env), profile)
          : null
      } else {
        try {
          teacher = await authenticateTeacher(getEduStore(env), {
            email: body?.email,
            password: body?.password,
            accessCode: body?.access_code,
          })
        } catch {
          teacher = null
        }
        providerName = body?.password ? 'password' : 'access-code'
      }
      if (!teacher) {
        return json({ error: 'Invalid teacher login', authenticated: false }, { status: 401 })
      }
      const sessionRecord = await createTeacherSession(authStore, teacher, providerName)
      return json(await getTeacherSession(authStore, `edu_teacher_session=${sessionRecord.id}`), {
        headers: {
          'Set-Cookie': teacherSessionCookie(sessionRecord.id),
        },
      })
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/auth/signup') {
      const authStore = getEduAuthStore(env)
      const store = await prepareEduStore(getEduStore(env))
      const body = await parseJsonRequest(request)
      try {
        const teacher = await createTeacherAccount(store, {
          name: body?.name,
          email: body?.email,
          password: body?.password,
        })
        const sessionRecord = await createTeacherSession(authStore, teacher, 'password')
        return json(await getTeacherSession(authStore, `edu_teacher_session=${sessionRecord.id}`), {
          status: 201,
          headers: {
            'Set-Cookie': teacherSessionCookie(sessionRecord.id),
          },
        })
      } catch (error) {
        return json(
          {
            error: error instanceof Error ? error.message : 'Could not create teacher account',
            authenticated: false,
          },
          { status: 400 },
        )
      }
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/auth/logout') {
      const authStore = getEduAuthStore(env)
      await destroyTeacherSession(authStore, request.headers.get('cookie'))
      return json({ authenticated: false, teacher_id: null, teacher_name: null, teacher_email: null }, {
        headers: {
          'Set-Cookie': clearTeacherSessionCookie(),
        },
      })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/classrooms') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await store.listClassrooms(teacherTenantId(session)))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/classrooms') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const body = await parseJsonRequest(request)
      let joinCode = ''
      try {
        joinCode = await resolveClassroomJoinCode(store, body.join_code)
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : 'Could not generate an unused join code' },
          { status: 503 },
        )
      }
      const classroom = buildClassroom({ ...body, tenant_id: teacherTenantId(session), join_code: joinCode })
      const conflict = await findJoinCodeConflict(store, classroom.join_code)
      if (conflict) {
        return json({ error: 'Join code already in use', join_code: classroom.join_code }, { status: 409 })
      }
      classroom.updated_at = nowIso()
      await store.putClassroom(classroom)
      await publishTeacherDashboard(env, classroom.tenant_id)
      return json(classroom, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = lastPathSegment(url.pathname)
      const classroom = id ? await store.getClassroom(id) : null
      if (classroom && classroom.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return classroom ? json(classroom) : json({ error: 'Not found' }, { status: 404 })
    }

    if (eduHost && request.method === 'PUT' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getClassroom(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const body = await parseJsonRequest(request)
      let joinCode = existing.join_code
      if (Object.prototype.hasOwnProperty.call(body, 'join_code')) {
        try {
          joinCode = await resolveClassroomJoinCode(store, body.join_code, existing.id)
        } catch (error) {
          return json(
            { error: error instanceof Error ? error.message : 'Could not generate an unused join code' },
            { status: 503 },
          )
        }
      }
      const classroom = buildClassroom({ ...existing, ...body, id, join_code: joinCode, updated_at: nowIso() })
      const conflict = await findJoinCodeConflict(store, classroom.join_code, classroom.id)
      if (conflict) {
        return json({ error: 'Join code already in use', join_code: classroom.join_code }, { status: 409 })
      }
      await store.putClassroom(classroom)
      await publishTeacherDashboard(env, classroom.tenant_id)
      await publishStudentBootstrapInvalidation(env, classroom, { reason: 'classroom-updated' })
      return json(classroom)
    }

    if (eduHost && request.method === 'POST' && /^\/api\/edu\/classrooms\/[^/]+\/students\/rename$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/')[4]
      const existing = id ? await store.getClassroom(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const body = await parseJsonRequest(request)
      try {
        const classroom = await renameClassroomStudent(store, existing, body.old_name, body.new_name)
        await publishTeacherDashboard(env, classroom.tenant_id)
        await publishStudentBootstrapInvalidation(env, classroom, { reason: 'student-renamed' })
        const assignments = await store.listAssignments(classroom.tenant_id)
        await Promise.allSettled(
          assignments
            .filter((assignment) => assignment.classroom_id === classroom.id)
            .map((assignment) => publishAssignmentSummary(env, assignment.id, assignment.tenant_id)),
        )
        return json(classroom)
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : 'Could not rename student' },
          { status: 400 },
        )
      }
    }

    if (eduHost && request.method === 'DELETE' && /^\/api\/edu\/classrooms\/[^/]+\/students\/[^/]+$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const id = parts[4]
      const studentName = decodeURIComponent(parts[6] || '')
      const existing = id ? await store.getClassroom(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      try {
        const classroom = await removeClassroomStudent(store, existing, studentName)
        await publishTeacherDashboard(env, classroom.tenant_id)
        await publishStudentBootstrapInvalidation(env, classroom, { reason: 'student-removed' })
        const assignments = await store.listAssignments(classroom.tenant_id)
        await Promise.allSettled(
          assignments
            .filter((assignment) => assignment.classroom_id === classroom.id)
            .map((assignment) => publishStudentAssignmentInvalidation(env, assignment)),
        )
        return json({ removed: true, classroom })
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : 'Could not remove student' },
          { status: 400 },
        )
      }
    }

    if (eduHost && request.method === 'DELETE' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getClassroom(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const assignments = await store.listAssignments(existing.tenant_id)
      for (const assignment of assignments.filter((item) => item.classroom_id === id)) {
        await publishStudentAssignmentInvalidation(env, assignment, { deleted: true })
        await store.deleteAssignment(assignment.id)
      }
      await store.deleteClassroom(id)
      await store.refreshDashboardSummary?.(existing.tenant_id)
      await publishTeacherDashboard(env, existing.tenant_id)
      await publishStudentBootstrapInvalidation(env, existing, { reason: 'classroom-deleted' })
      return json({ deleted: true, classroom_id: id })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/assignments') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await store.listAssignments(teacherTenantId(session)))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/assignments') {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const assignment = buildAssignment({ ...(await parseJsonRequest(request)), tenant_id: teacherTenantId(session) })
      assignment.updated_at = nowIso()
      await store.putAssignment(assignment)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({ action: 'created', assignment, actor: session }),
      )
      const publishPromise = Promise.allSettled([
        publishTeacherDashboard(env, assignment.tenant_id),
        publishAssignmentSummary(env, assignment.id, assignment.tenant_id),
        publishStudentBootstrapInvalidation(env, assignment, {
          reason: 'assignment-created',
          assignmentId: assignment.id,
        }),
      ])
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json(assignment, { status: 201 })
    }

    if (
      eduHost &&
      request.method === 'GET' &&
      /\/api\/edu\/assignments\/[^/]+\/live-summaries$/.test(url.pathname)
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!assignment || assignment.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return json({
        assignment_id: assignmentId,
        live_sessions: await buildAssignmentLiveSummaries(store, assignmentId),
        updated_at: nowIso(),
      })
    }

    if (
      eduHost &&
      request.method === 'GET' &&
      url.pathname.startsWith('/api/edu/assignments/') &&
      !url.pathname.endsWith('/audit') &&
      !url.pathname.endsWith('/live-summaries')
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const assignment = id ? await store.getAssignment(id) : null
      if (assignment && assignment.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return assignment ? json(assignment) : json({ error: 'Not found' }, { status: 404 })
    }

    if (
      eduHost &&
      request.method === 'POST' &&
      /\/api\/edu\/assignments\/[^/]+\/access-requests$/.test(url.pathname)
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const existing = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const body = await parseJsonRequest(request)
      const studentName = String(body?.student_name || '').trim()
      if (!studentName) {
        return json({ error: 'Student name is required' }, { status: 400 })
      }
      const normalizedKey = studentName.toLowerCase()
      const updatedAssignment = buildAssignment({
        ...existing,
        student_access_requests: {
          ...(existing.student_access_requests || {}),
          [normalizedKey]: {
            student_name: studentName,
            requested_at: nowIso(),
            note: String(body?.note || ''),
          },
        },
        updated_at: nowIso(),
      })
      await store.putAssignment(updatedAssignment)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'updated',
          assignment: updatedAssignment,
          previousAssignment: existing,
          actor: null,
        }),
      )
      const classroom = updatedAssignment.classroom_id ? await store.getClassroom(updatedAssignment.classroom_id) : null
      const publishTasks = [
        publishStudentAccessRequest(
          env,
          updatedAssignment,
          normalizedKey,
          updatedAssignment.student_access_requests?.[normalizedKey] || null,
        ),
        publishTeacherDashboard(env, updatedAssignment.tenant_id),
        publishAssignmentSummary(env, updatedAssignment.id, updatedAssignment.tenant_id),
      ]
      if (classroom) {
        publishTasks.push(publishStudentAssignment(env, updatedAssignment, studentName, classroom.join_code))
      }
      publishTasks.push(publishStudentBootstrapInvalidation(env, updatedAssignment, {
        reason: 'access-requested',
        assignmentId: updatedAssignment.id,
      }))
      const publishPromise = Promise.allSettled(publishTasks)
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json(
        {
          assignment_id: updatedAssignment.id,
          student_access_request: updatedAssignment.student_access_requests?.[normalizedKey] || null,
        },
        { status: 201 },
      )
    }

    if (
      eduHost &&
      request.method === 'POST' &&
      /\/api\/edu\/assignments\/[^/]+\/feedback-requests$/.test(url.pathname)
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const existing = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const body = await parseJsonRequest(request)
      const studentName = String(body?.student_name || '').trim()
      if (!studentName) {
        return json({ error: 'Student name is required' }, { status: 400 })
      }
      const normalizedKey = studentName.toLowerCase()
      const updatedAssignment = buildAssignment({
        ...existing,
        student_feedback_requests: {
          ...(existing.student_feedback_requests || {}),
          [normalizedKey]: {
            student_name: studentName,
            requested_at: nowIso(),
            note: String(body?.note || ''),
          },
        },
        updated_at: nowIso(),
      })
      await store.putAssignment(updatedAssignment)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'updated',
          assignment: updatedAssignment,
          previousAssignment: existing,
          actor: null,
        }),
      )
      const classroom = updatedAssignment.classroom_id ? await store.getClassroom(updatedAssignment.classroom_id) : null
      const publishTasks = [
        publishTeacherDashboard(env, updatedAssignment.tenant_id),
        publishAssignmentSummary(env, updatedAssignment.id, updatedAssignment.tenant_id),
      ]
      if (classroom) {
        publishTasks.push(publishStudentAssignment(env, updatedAssignment, studentName, classroom.join_code))
      }
      publishTasks.push(publishStudentBootstrapInvalidation(env, updatedAssignment, {
        reason: 'feedback-requested',
        assignmentId: updatedAssignment.id,
      }))
      const publishPromise = Promise.allSettled(publishTasks)
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json(
        {
          assignment_id: updatedAssignment.id,
          student_feedback_request: updatedAssignment.student_feedback_requests?.[normalizedKey] || null,
        },
        { status: 201 },
      )
    }

    if (
      eduHost &&
      request.method === 'DELETE' &&
      /^\/api\/edu\/assignments\/[^/]+\/feedback-requests\/[^/]+$/.test(url.pathname)
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const assignmentId = pathSegment(url.pathname, 4)
      const studentName = decodeURIComponent(parts[parts.length - 1] || '').trim()
      const existing = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      if (!studentName) {
        return json({ error: 'Student name is required' }, { status: 400 })
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
        await store.putAssignment(updatedAssignment)
        await store.putAssignmentAudit(
          buildAssignmentAuditRecord({
            action: 'updated',
            assignment: updatedAssignment,
            previousAssignment: existing,
            actor: session,
          }),
        )
      }
      const publishPromise = hadRequest
        ? Promise.allSettled([
            publishTeacherDashboard(env, updatedAssignment.tenant_id),
            publishAssignmentSummary(env, updatedAssignment.id, updatedAssignment.tenant_id),
            publishStudentAssignmentInvalidation(env, updatedAssignment),
          ])
        : Promise.resolve([])
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json({
        assignment_id: updatedAssignment.id,
        assignment: updatedAssignment,
        dismissed: hadRequest,
        student_name: studentName,
        student_feedback_request: null,
      })
    }

    if (eduHost && request.method === 'PUT' && url.pathname.startsWith('/api/edu/assignments/')) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getAssignment(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const assignment = buildAssignment({ ...existing, ...(await parseJsonRequest(request)), id, updated_at: nowIso() })
      await store.putAssignment(assignment)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'updated',
          assignment,
          previousAssignment: existing,
          actor: session,
        }),
      )
      const publishPromise = Promise.allSettled([
        publishTeacherDashboard(env, assignment.tenant_id),
        publishAssignmentSummary(env, assignment.id, assignment.tenant_id),
        publishStudentAssignmentInvalidation(env, assignment),
        publishStudentBootstrapInvalidation(env, assignment, {
          reason: 'assignment-updated',
          assignmentId: assignment.id,
        }),
      ])
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json(assignment)
    }

    if (
      eduHost &&
      request.method === 'DELETE' &&
      url.pathname.startsWith('/api/edu/assignments/') &&
      !url.pathname.endsWith('/audit')
    ) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getAssignment(id) : null
      if (!existing || existing.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      await store.deleteAssignment(id)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({
          action: 'deleted',
          previousAssignment: existing,
          actor: session,
        }),
      )
      await store.refreshDashboardSummary?.(existing.tenant_id)
      await publishTeacherDashboard(env, existing.tenant_id)
      await publishStudentAssignmentInvalidation(env, existing, { deleted: true })
      await publishStudentBootstrapInvalidation(env, existing, {
        reason: 'assignment-deleted',
        assignmentId: existing.id,
      })
      return json({ deleted: true, assignment_id: id })
    }

    if (eduHost && request.method === 'GET' && /\/api\/edu\/assignments\/[^/]+\/audit$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!assignment || assignment.tenant_id !== teacherTenantId(session)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const audits = await store.listAssignmentAuditsByAssignmentId(assignmentId, assignment.tenant_id)
      return json(audits)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json((await store.listLiveSessions(teacherTenantId(session))).map((item) => buildLiveSession(item)))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const incoming = await parseJsonRequest(request)
      const shouldCaptureReplay = Boolean(incoming?.capture_replay)
      const nextId =
        incoming.id ||
        `${incoming.student_name || 'student'}:${incoming.assignment_id || 'assignment'}`
      const existing = await store.getLiveSession(nextId)
      let assignment = incoming.assignment_id ? await store.getAssignment(incoming.assignment_id) : null
      const draftMerge = mergeLiveSessionDraft(incoming || {}, existing || {})
      if (draftMerge.error) {
        return json(draftMerge.error.body, { status: draftMerge.error.status })
      }
      const session = buildLiveSession({
        ...existing,
        ...incoming,
        tenant_id: existing?.tenant_id || assignment?.tenant_id || incoming.tenant_id || DEFAULT_TENANT_ID,
        id: nextId,
        current_text: draftMerge.session.current_text,
        document_history: draftMerge.session.document_history,
        grading:
          incoming.grading && typeof incoming.grading === 'object'
            ? incoming.grading
            : existing?.grading,
        updated_at: nowIso(),
      })
      await store.putLiveSession(session)
      const feedbackRequest = studentFeedbackRequestForStudent(assignment, session.student_name)
      let clearedFeedbackRequest = false
      if (assignment && liveSessionActivityIsAfterFeedbackRequest(session, feedbackRequest)) {
        assignment = buildAssignment({
          ...assignment,
          student_feedback_requests: studentFeedbackRequestsAfterFeedback(assignment, session.student_name),
          updated_at: nowIso(),
        })
        await store.putAssignment(assignment)
        clearedFeedbackRequest = true
      }
      const backgroundPublish = (async () => {
        await publishAssignmentLiveSession(env, session)
        if (shouldCaptureReplay) {
          await appendLiveReplayUpdate(store, session)
        }
        await publishTeacherDashboardLiveSession(env, session)
        if (clearedFeedbackRequest && assignment) {
          await publishTeacherDashboard(env, assignment.tenant_id)
        }
        await publishAssignmentSummary(env, session.assignment_id, session.tenant_id, { includeAudits: false })
        if (shouldCaptureReplay) {
          await publishReplayUpdate(env, session.id, session.tenant_id)
        }
      })()
      if (ctx?.waitUntil) {
        ctx.waitUntil(backgroundPublish.catch(() => {}))
      } else {
        backgroundPublish.catch(() => {})
      }
      return json({ ...session, ...draftMerge.ack }, { status: 201 })
    }

    if (
      eduHost &&
      request.method === 'PUT' &&
      /\/api\/edu\/live-sessions\/[^/]+\/grading$/.test(url.pathname)
    ) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const sessionId = pathSegment(url.pathname, parts.length - 2)
      const body = await parseJsonRequest(request)
      const teacherTenant = teacherTenantId(teacherSession)
      let existing =
        (await resolveLiveSessionForGrading(store, sessionId)) ||
        (await liveSessionFromGradingSnapshot(store, sessionId, body, teacherTenant))
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const assignment = existing.assignment_id ? await store.getAssignment(existing.assignment_id) : null
      if (existing.tenant_id !== teacherTenant) {
        if (!assignment || assignment.tenant_id !== teacherTenant) {
          return json({ error: 'Not found' }, { status: 404 })
        }
        existing = buildLiveSession({ ...existing, tenant_id: assignment.tenant_id })
      }
      const incomingAnnotations = Array.isArray(body?.inline_annotations) ? body.inline_annotations : []
      if (
        suggestionsIntroduceUnsafeChanges(existing?.grading?.inline_annotations, incomingAnnotations) &&
        !canSafelySubmitSuggestions(existing, assignment)
      ) {
        return json(
          {
            error: 'Suggestions can only be added when the student can no longer edit this draft with certainty.',
          },
          { status: 409 },
        )
      }
      const publishFields = gradingPublishFields(body, existing?.grading)
      let grading = {
        rubric_scores:
          body?.rubric_scores && typeof body.rubric_scores === 'object'
            ? normalizedRubricScoresForAssignment(body.rubric_scores, assignment)
            : {},
        teacher_comment: String(body?.teacher_comment || ''),
        returned_for_revision: Boolean(body?.returned_for_revision),
        grade_label: String(body?.grade_label || ''),
        grade_score:
          body?.grade_score === '' || body?.grade_score == null ? null : Number(body?.grade_score),
        inline_annotations: incomingAnnotations,
        updated_at: nowIso(),
        ...publishFields,
        actor_id: teacherSession.teacher_id || null,
        actor_name: teacherSession.teacher_name || null,
        actor_email: teacherSession.teacher_email || null,
      }
      if (
        gradingHasStudentVisibleFeedback(existing?.grading) &&
        !gradingHasStudentVisibleFeedback(grading) &&
        body?.allow_empty_feedback !== true
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
      await store.putLiveSession(updated)
      let assignmentForStudentPublish = assignment
      if (assignment && grading.feedback_status === 'published' && gradingHasStudentVisibleFeedback(grading)) {
        assignmentForStudentPublish = buildAssignment({
          ...assignment,
          student_feedback: grading,
          student_feedback_requests: studentFeedbackRequestsAfterFeedback(assignment, updated.student_name),
          updated_at: nowIso(),
        })
        await store.putAssignment(assignmentForStudentPublish)
      }
      const classroom = assignment?.classroom_id ? await store.getClassroom(assignment.classroom_id) : null
      const publishTasks = [
        publishAssignmentSummary(env, updated.assignment_id, updated.tenant_id),
      ]
      if (assignmentForStudentPublish && assignmentForStudentPublish !== assignment) {
        publishTasks.push(publishTeacherDashboard(env, assignmentForStudentPublish.tenant_id))
      }
      if (assignmentForStudentPublish && classroom && grading.feedback_status === 'published') {
        publishTasks.push(publishStudentAssignment(env, assignmentForStudentPublish, updated.student_name, classroom.join_code))
      }
      const publishPromise = Promise.allSettled(publishTasks)
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json(updated)
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/live-sessions/')) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = lastPathSegment(url.pathname)
      const liveSession = id ? await store.getLiveSession(id) : null
      if (liveSession && liveSession.tenant_id !== teacherTenantId(teacherSession)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return liveSession ? json(buildLiveSession(liveSession)) : json({ error: 'Not found' }, { status: 404 })
    }

    if (eduHost && request.method === 'GET' && /^\/api\/edu\/live-replays\/[^/]+\/updates$/.test(url.pathname)) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const headId = pathSegment(url.pathname, 4)
      const head = headId ? await store.getLiveReplayHead(headId) : null
      if (!head || head.tenant_id !== teacherTenantId(teacherSession)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const sinceSeq = Math.max(0, Number(url.searchParams.get('since_seq') || 0) || 0)
      const events = (await store.listLiveReplayEvents(head.id, head.tenant_id)).filter((event) => event.seq > sinceSeq)
      const replay = head.replay_session_id ? await store.getReplay(head.replay_session_id) : null
      return json({
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
    }

    if (eduHost && request.method === 'GET' && /^\/api\/edu\/live-replays\/[^/]+$/.test(url.pathname)) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const headId = lastPathSegment(url.pathname)
      const head = headId ? await store.getLiveReplayHead(headId) : null
      if (head) {
        if (head.tenant_id !== teacherTenantId(teacherSession)) {
          return json({ error: 'Not found' }, { status: 404 })
        }
        const replay = head.replay_session_id ? await store.getReplay(head.replay_session_id) : null
        return json(buildLiveReplayResponse(head, await store.listLiveReplayEvents(head.id, head.tenant_id), replay))
      }
      const liveSession = headId ? await store.getLiveSession(headId) : null
      if (!liveSession || liveSession.tenant_id !== teacherTenantId(teacherSession)) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const replay = liveSession.replay_session_id ? await store.getReplay(liveSession.replay_session_id) : null
      const fallbackHead = liveReplayHeadFromSession(liveSession, null, replay)
      return json(buildLiveReplayResponse(fallbackHead, [], replay))
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/replays/')) {
      const store = getEduStore(env)
      const replayId = lastPathSegment(url.pathname)
      let stored = replayId ? await store.getReplay(replayId) : null
      
      if (!stored) {
        const liveSession = await store.getLiveSession(replayId.replace('replay:', ''))
        if (liveSession) {
          stored = replayFromLiveSessionFallback(replayId, liveSession)
        }
      }
      
      if (!stored) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return json(stored)
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/replays') {
      const store = getEduStore(env)
      const replay = buildEduReplay({ ...(await parseJsonRequest(request)), updated_at: nowIso() })
      await store.putReplay(replay)
      if (replay.live_session_id) {
        const existingHead = await store.getLiveReplayHead(replay.live_session_id)
        if (existingHead) {
          await store.putLiveReplayHead(
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
      await publishReplayUpdate(env, replay.live_session_id, replay.tenant_id)
      return json(replay, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/student/config') {
      const store = await prepareEduStore(getEduStore(env))
      return json(
        await buildStudentConfig(store, {
          joinCode: url.searchParams.get('join_code') || '',
          studentName: url.searchParams.get('student_name') || '',
        }),
      )
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/student/assignments/')) {
      const store = await prepareEduStore(getEduStore(env))
      const assignmentId = url.pathname.split('/').pop()
      const result = await buildStudentActiveAssignmentState(store, {
        assignmentId,
        joinCode: url.searchParams.get('join_code') || '',
        studentName: url.searchParams.get('student_name') || '',
      })
      if (!result.classroom || !result.assignment) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return json(result)
    }

    if (eduHost && request.method === 'POST' && /^\/api\/edu\/student\/assignments\/[^/]+\/open$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const assignmentId = url.pathname.split('/').slice(-2, -1)[0]
      const body = await request.json().catch(() => ({}))
      const studentName = String(body?.student_name || '').trim()
      const joinCode = String(body?.join_code || '').trim()
      const result = await buildStudentAssignmentConfig(store, {
        assignmentId,
        joinCode,
        studentName,
      })
      if (!result.classroom || !result.assignment || !studentName) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      await store.putAssignmentAudit({
        tenant_id: result.assignment.tenant_id,
        assignment_id: result.assignment.id,
        classroom_id: result.assignment.classroom_id,
        assignment_title: result.assignment.title,
        action: 'student_opened',
        actor_id: null,
        actor_name: null,
        actor_email: null,
        summary: `${studentName} opened the assignment`,
        changes: [{ label: 'Student assignment open', before: null, after: studentName }],
        snapshot: result.assignment,
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      return json({ recorded: true, assignment_id: result.assignment.id, student_name: studentName }, { status: 201 })
    }

    if (eduHost && request.method === 'POST' && /^\/api\/edu\/student\/assignments\/[^/]+\/feedback-resolutions$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const assignmentId = url.pathname.split('/').slice(-2, -1)[0]
      const body = await request.json().catch(() => ({}))
      const studentName = String(body?.student_name || '').trim()
      const joinCode = String(body?.join_code || '').trim()
      const annotationKey = String(body?.annotation_key || '').trim()
      const result = await buildStudentAssignmentConfig(store, {
        assignmentId,
        joinCode,
        studentName,
      })
      if (!result.classroom || !result.assignment || !studentName) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      if (!annotationKey) {
        return json({ error: 'Annotation key is required' }, { status: 400 })
      }
      const session = await store.getLiveSessionForAssignmentStudent(
        assignmentId,
        studentName,
        result.assignment.tenant_id,
      )
      if (!session?.grading?.inline_annotations?.length) {
        return json({ error: 'Feedback annotation not found' }, { status: 404 })
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
        return json({ error: 'Feedback annotation not found' }, { status: 404 })
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
      await store.putLiveSession(updatedSession)
      const publishTasks = [
        publishAssignmentLiveSession(env, updatedSession),
        publishTeacherDashboardLiveSession(env, updatedSession),
        publishAssignmentSummary(env, assignmentId, updatedSession.tenant_id),
        publishStudentAssignment(env, result.assignment, studentName, result.classroom.join_code),
      ]
      const publishPromise = Promise.allSettled(publishTasks)
      if (ctx?.waitUntil) {
        ctx.waitUntil(publishPromise)
      } else {
        await publishPromise
      }
      return json({ ok: true, annotation_key: annotationKey, resolved_at: resolvedAt })
    }

    if (eduHost && request.method === 'POST' && /^\/api\/edu\/student\/assignments\/[^/]+\/close$/.test(url.pathname)) {
      const store = await prepareEduStore(getEduStore(env))
      const assignmentId = url.pathname.split('/').slice(-2, -1)[0]
      const body = await request.json().catch(() => ({}))
      const studentName = String(body?.student_name || '').trim()
      const joinCode = String(body?.join_code || '').trim()
      const result = await buildStudentAssignmentConfig(store, {
        assignmentId,
        joinCode,
        studentName,
      })
      if (!result.classroom || !result.assignment || !studentName) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const existing = await store.getAssignment(result.assignment.id)
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }

      const normalizedKey = studentName.toLowerCase()
      const shouldRequireApproval = Boolean(result.assignment.policy?.require_permission_to_rejoin)
      const closedAt = nowIso()
      const rejoinBlockedUntil = shouldRequireApproval
        ? scheduleStateForAssignment(existing, studentName, new Date(closedAt)).session_end_at
        : null
      const updatedAssignment = shouldRequireApproval
        ? buildAssignment({
            ...existing,
            student_access_revoked: {
              ...(existing.student_access_revoked || {}),
              [normalizedKey]: true,
            },
            student_access_revoked_until: {
              ...(existing.student_access_revoked_until || {}),
              ...(rejoinBlockedUntil ? { [normalizedKey]: rejoinBlockedUntil } : {}),
            },
            updated_at: closedAt,
          })
        : existing

      if (updatedAssignment !== existing) {
        await store.putAssignment(updatedAssignment)
      }
      const liveSessionId = `${studentName}:${updatedAssignment.id}`
      const existingLiveSession = await store.getLiveSession(liveSessionId)
      let closedLiveSession = null
      if (existingLiveSession) {
        closedLiveSession = buildLiveSession({
          ...existingLiveSession,
          focused: false,
          schedule_open: false,
          last_activity_at: closedAt,
          updated_at: closedAt,
        })
        await store.putLiveSession(closedLiveSession)
      }
      await store.putAssignmentAudit({
        tenant_id: updatedAssignment.tenant_id,
        assignment_id: updatedAssignment.id,
        classroom_id: updatedAssignment.classroom_id,
        assignment_title: updatedAssignment.title,
        action: 'student_closed',
        actor_id: null,
        actor_name: null,
        actor_email: null,
        summary: shouldRequireApproval
          ? `${studentName} left and now needs approval to return`
          : `${studentName} left the assignment`,
        changes: [
          {
            label: shouldRequireApproval ? 'Student re-entry approval required' : 'Student assignment close',
            before: null,
            after: studentName,
          },
        ],
        snapshot: updatedAssignment,
        created_at: closedAt,
        updated_at: closedAt,
      })
      const publishTasks = [
        publishTeacherDashboard(env, updatedAssignment.tenant_id),
        publishAssignmentSummary(env, updatedAssignment.id, updatedAssignment.tenant_id),
        publishStudentAssignment(env, updatedAssignment, studentName, result.classroom.join_code),
      ]
      if (closedLiveSession) {
        publishTasks.push(publishAssignmentLiveSession(env, closedLiveSession))
        publishTasks.push(publishTeacherDashboardLiveSession(env, closedLiveSession))
      }
      await Promise.allSettled(publishTasks)
      return json(
        {
          recorded: true,
          assignment_id: updatedAssignment.id,
          student_name: studentName,
          access_revoked: shouldRequireApproval,
        },
        { status: 201 },
      )
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
      eduHost &&
      request.method === 'GET' &&
      (url.pathname.startsWith('/replay/') || /^\/replay\/[^/]+$/.test(url.pathname))
    ) {
      return serveEduReplayHtml(request, env)
    }

    if (
      request.method === 'GET' &&
      (isCanonicalReplayPath(url.pathname) || /^\/replay\/[^/]+$/.test(url.pathname))
    ) {
      return serveReplayHtml(request, env)
    }

    return env.ASSETS.fetch(request)
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledEduMaintenance(env))
  },
}

export { EduRealtimeHub }
