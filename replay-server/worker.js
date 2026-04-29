import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'
import {
  buildAssignmentLiveSummaries,
  buildAssignmentAuditRecord,
  buildEduDashboard,
  buildEduDashboardDelta,
  buildStudentAssignmentConfig,
  buildStudentConfig,
  createD1EduStore,
  createKvEduStore,
  ensureEduSeedData,
} from './edu-store.js'
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
  authenticateTeacher,
  authenticateTeacherWithGoogle,
  clearTeacherSessionCookie,
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

  const classrooms = await store.listClassrooms()
  return (
    classrooms.find(
      (classroom) =>
        classroom.id !== excludeClassroomId &&
        String(classroom.join_code || '').trim().toUpperCase() === normalizedJoinCode,
    ) || null
  )
}

function defaultTeacher(env) {
  return {
    id: 'teacher_default',
    name: 'Joseph Tan',
    email: env.EDU_TEACHER_EMAIL || 'teacher@edu.handtyped.app',
    access_code: env.EDU_TEACHER_ACCESS_CODE || 'handtyped-edu',
  }
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
  async fetch(request, env) {
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

    if (eduHost && request.method === 'GET' && /^\/edu\/replay\/[^/]+$/.test(url.pathname)) {
      return serveEduReplayHtml(request, env)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/dashboard') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await buildSafeEduDashboard(store))
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/dashboard/updates') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await buildEduDashboardDelta(store, { since: url.searchParams.get('since') || '' }))
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
      const fallbackTeacher = defaultTeacher(env)
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

        await ensureEduSeedData(getEduStore(env))
        teacher = profile
          ? await authenticateTeacherWithGoogle(getEduStore(env), profile)
          : null
      } else {
        const normalizedEmail = String(body?.email || '').trim().toLowerCase()
        if (
          normalizedEmail === fallbackTeacher.email.toLowerCase() &&
          (String(body?.password || '') === fallbackTeacher.access_code ||
            String(body?.access_code || '') === fallbackTeacher.access_code)
        ) {
          teacher = fallbackTeacher
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
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await store.listClassrooms())
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/classrooms') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const classroom = buildClassroom(await parseJsonRequest(request))
      const conflict = await findJoinCodeConflict(store, classroom.join_code)
      if (conflict) {
        return json({ error: 'Join code already in use', join_code: classroom.join_code }, { status: 409 })
      }
      classroom.updated_at = nowIso()
      await store.putClassroom(classroom)
      return json(classroom, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const classroom = id ? await store.getClassroom(id) : null
      return classroom ? json(classroom) : json({ error: 'Not found' }, { status: 404 })
    }

    if (eduHost && request.method === 'PUT' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getClassroom(id) : null
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const classroom = buildClassroom({ ...existing, ...(await parseJsonRequest(request)), id, updated_at: nowIso() })
      const conflict = await findJoinCodeConflict(store, classroom.join_code, classroom.id)
      if (conflict) {
        return json({ error: 'Join code already in use', join_code: classroom.join_code }, { status: 409 })
      }
      await store.putClassroom(classroom)
      return json(classroom)
    }

    if (eduHost && request.method === 'DELETE' && url.pathname.startsWith('/api/edu/classrooms/')) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getClassroom(id) : null
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const assignments = await store.listAssignments()
      for (const assignment of assignments.filter((item) => item.classroom_id === id)) {
        await store.deleteAssignment(assignment.id)
      }
      await store.deleteClassroom(id)
      return json({ deleted: true, classroom_id: id })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/assignments') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await store.listAssignments())
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/assignments') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const assignment = buildAssignment(await parseJsonRequest(request))
      assignment.updated_at = nowIso()
      await store.putAssignment(assignment)
      await store.putAssignmentAudit(
        buildAssignmentAuditRecord({ action: 'created', assignment, actor: session }),
      )
      return json(assignment, { status: 201 })
    }

    if (
      eduHost &&
      request.method === 'GET' &&
      /\/api\/edu\/assignments\/[^/]+\/live-summaries$/.test(url.pathname)
    ) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!assignment) {
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
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const assignment = id ? await store.getAssignment(id) : null
      return assignment ? json(assignment) : json({ error: 'Not found' }, { status: 404 })
    }

    if (
      eduHost &&
      request.method === 'POST' &&
      /\/api\/edu\/assignments\/[^/]+\/access-requests$/.test(url.pathname)
    ) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
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
      return json(
        {
          assignment_id: updatedAssignment.id,
          student_access_request: updatedAssignment.student_access_requests?.[normalizedKey] || null,
        },
        { status: 201 },
      )
    }

    if (eduHost && request.method === 'PUT' && url.pathname.startsWith('/api/edu/assignments/')) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getAssignment(id) : null
      if (!existing) {
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
      return json(assignment)
    }

    if (
      eduHost &&
      request.method === 'DELETE' &&
      url.pathname.startsWith('/api/edu/assignments/') &&
      !url.pathname.endsWith('/audit')
    ) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const existing = id ? await store.getAssignment(id) : null
      if (!existing) {
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
      return json({ deleted: true, assignment_id: id })
    }

    if (eduHost && request.method === 'GET' && /\/api\/edu\/assignments\/[^/]+\/audit$/.test(url.pathname)) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const parts = url.pathname.split('/')
      const assignmentId = parts[parts.length - 2]
      const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
      if (!assignment) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const audits = (await store.listAssignmentAudits()).filter((item) => item.assignment_id === assignmentId)
      return json(audits)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json((await store.listLiveSessions()).map((item) => buildLiveSession(item)))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const incoming = await parseJsonRequest(request)
      const nextId =
        incoming.id ||
        `${incoming.student_name || 'student'}:${incoming.assignment_id || 'assignment'}`
      const existing = await store.getLiveSession(nextId)
      const session = buildLiveSession({
        ...existing,
        ...incoming,
        id: nextId,
        grading:
          incoming.grading && typeof incoming.grading === 'object'
            ? incoming.grading
            : existing?.grading,
        updated_at: nowIso(),
      })
      await store.putLiveSession(session)
      await appendLiveReplayUpdate(store, session)
      return json(session, { status: 201 })
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
      const sessionId = parts[parts.length - 2]
      const existing = sessionId ? await store.getLiveSession(sessionId) : null
      if (!existing) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const body = await parseJsonRequest(request)
      const grading = {
        rubric_scores:
          body?.rubric_scores && typeof body.rubric_scores === 'object'
            ? { ...body.rubric_scores }
            : {},
        teacher_comment: String(body?.teacher_comment || ''),
        returned_for_revision: Boolean(body?.returned_for_revision),
        grade_label: String(body?.grade_label || ''),
        grade_score:
          body?.grade_score === '' || body?.grade_score == null ? null : Number(body?.grade_score),
        inline_annotations: Array.isArray(body?.inline_annotations) ? body.inline_annotations : [],
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
      await store.putLiveSession(updated)
      return json(updated)
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/live-sessions/')) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const liveSession = id ? await store.getLiveSession(id) : null
      return liveSession ? json(buildLiveSession(liveSession)) : json({ error: 'Not found' }, { status: 404 })
    }

    if (eduHost && request.method === 'GET' && /^\/api\/edu\/live-replays\/[^/]+\/updates$/.test(url.pathname)) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const headId = url.pathname.split('/')[4]
      const head = headId ? await store.getLiveReplayHead(headId) : null
      if (!head) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const sinceSeq = Math.max(0, Number(url.searchParams.get('since_seq') || 0) || 0)
      const events = (await store.listLiveReplayEvents(head.id)).filter((event) => event.seq > sinceSeq)
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
      const headId = url.pathname.split('/').pop()
      const head = headId ? await store.getLiveReplayHead(headId) : null
      if (head) {
        const replay = head.replay_session_id ? await store.getReplay(head.replay_session_id) : null
        return json(buildLiveReplayResponse(head, await store.listLiveReplayEvents(head.id), replay))
      }
      const liveSession = headId ? await store.getLiveSession(headId) : null
      if (!liveSession) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      const replay = liveSession.replay_session_id ? await store.getReplay(liveSession.replay_session_id) : null
      const fallbackHead = liveReplayHeadFromSession(liveSession, null, replay)
      return json(buildLiveReplayResponse(fallbackHead, [], replay))
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/replays/')) {
      const store = getEduStore(env)
      const replayId = url.pathname.split('/').pop()
      let stored = replayId ? await store.getReplay(replayId) : null
      
      if (!stored) {
        const liveSession = await store.getLiveSession(replayId.replace('replay:', ''))
        if (liveSession) {
          stored = buildEduReplay({
            id: replayId,
            live_session_id: replayId,
            assignment_id: liveSession.assignment_id,
            assignment_title: liveSession.assignment_title,
            course: liveSession.course,
            classroom: liveSession.classroom,
            student_name: liveSession.student_name,
            current_text: liveSession.current_text,
            document_history: liveSession.document_history,
            keystroke_log: liveSession.keystroke_log,
            focus_events: liveSession.focus_events,
            last_activity_at: liveSession.last_activity_at,
            focused: liveSession.focused,
            hid_active: liveSession.hid_active,
          })
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
      return json(replay, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/student/config') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      return json(
        await buildStudentConfig(store, {
          joinCode: url.searchParams.get('join_code') || '',
          studentName: url.searchParams.get('student_name') || '',
        }),
      )
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/student/assignments/')) {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      const assignmentId = url.pathname.split('/').pop()
      const result = await buildStudentAssignmentConfig(store, {
        assignmentId,
        joinCode: url.searchParams.get('join_code') || '',
        studentName: url.searchParams.get('student_name') || '',
      })
      if (!result.classroom || !result.assignment) {
        return json({ error: 'Not found' }, { status: 404 })
      }
      return json(result)
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
}
