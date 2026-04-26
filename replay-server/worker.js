import { parseReplayAttestation, buildReplayUrl } from './session-store.js'
import { parseTrustedSignerAllowlist } from './trusted-signers.js'
import { createReplayGuardrails, resolveReplayUploadRateLimit } from './guardrails.js'
import { buildEduDashboard, buildStudentConfig, createD1EduStore, createKvEduStore, ensureEduSeedData } from './edu-store.js'
import { buildAssignment, buildClassroom, buildEduReplay, nowIso } from './edu-schema.js'
import {
  authenticateTeacher,
  clearTeacherSessionCookie,
  createTeacherSession,
  destroyTeacherSession,
  getTeacherSession,
  teacherSessionCookie,
} from './edu-auth.js'

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
  const live_sessions = await safeList(() => store.listLiveSessions())
  const replays = await safeList(() => store.listReplays())

  return {
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
    },
    classrooms,
    assignments,
    live_sessions,
    architecture: {
      teacher_web_origin: 'https://edu.handtyped.app',
      replay_origin: 'https://replay.handtyped.app',
      student_delivery: 'native desktop app',
    },
  }
}

function defaultTeacher(env) {
  return {
    id: 'teacher_default',
    name: 'Joseph Tan',
    email: env.EDU_TEACHER_EMAIL || 'teacher@edu.handtyped.app',
    access_code: env.EDU_TEACHER_ACCESS_CODE || 'handtyped-edu',
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

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/config') {
      return json({
        host: 'edu.handtyped.app',
        teacher_surface: 'web',
        student_surface: 'native',
        replay_origin: 'https://replay.handtyped.app',
      })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/auth/session') {
      return json(await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie')))
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/auth/login') {
      const authStore = getEduAuthStore(env)
      const body = await parseJsonRequest(request)
      const fallbackTeacher = defaultTeacher(env)
      const normalizedEmail = String(body?.email || '').trim().toLowerCase()
      let teacher = null

      if (
        normalizedEmail === fallbackTeacher.email.toLowerCase() &&
        String(body?.access_code || '') === fallbackTeacher.access_code
      ) {
        teacher = fallbackTeacher
      } else {
        try {
          teacher = await authenticateTeacher(getEduStore(env), {
            email: body?.email,
            accessCode: body?.access_code,
          })
        } catch {
          teacher = null
        }
      }
      if (!teacher) {
        return json({ error: 'Invalid teacher email or access code', authenticated: false }, { status: 401 })
      }
      const sessionRecord = await createTeacherSession(authStore, teacher)
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
      return json(assignment, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/assignments/')) {
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
      return json(assignment)
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const session = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!session.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      return json(await store.listLiveSessions())
    }

    if (eduHost && request.method === 'POST' && url.pathname === '/api/edu/live-sessions') {
      const store = getEduStore(env)
      const incoming = await parseJsonRequest(request)
      const session = {
        ...incoming,
        id:
          incoming.id ||
          `${incoming.student_name || 'student'}:${incoming.assignment_id || 'assignment'}`,
        updated_at: nowIso(),
      }
      await store.putLiveSession(session)
      return json(session, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname.startsWith('/api/edu/live-sessions/')) {
      const store = getEduStore(env)
      const teacherSession = await getTeacherSession(getEduAuthStore(env), request.headers.get('cookie'))
      if (!teacherSession.authenticated) {
        return json({ error: 'Unauthorized', authenticated: false }, { status: 401 })
      }
      const id = url.pathname.split('/').pop()
      const liveSession = id ? await store.getLiveSession(id) : null
      return liveSession ? json(liveSession) : json({ error: 'Not found' }, { status: 404 })
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
      return json(replay, { status: 201 })
    }

    if (eduHost && request.method === 'GET' && url.pathname === '/api/edu/student/config') {
      const store = getEduStore(env)
      await ensureEduSeedData(store)
      return json(
        await buildStudentConfig(store, {
          joinCode: url.searchParams.get('join_code') || '',
        }),
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
}
