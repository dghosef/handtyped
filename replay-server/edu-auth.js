import { buildTeacherAuthSession, buildTeacherSessionRecord, normalizeTeacherEmail } from './edu-schema.js'

export const EDU_SESSION_COOKIE = 'edu_teacher_session'

function cookieValue(rawCookieHeader, name) {
  const raw = String(rawCookieHeader || '')
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }
    const pivot = trimmed.indexOf('=')
    const key = pivot >= 0 ? trimmed.slice(0, pivot) : trimmed
    if (key === name) {
      return pivot >= 0 ? trimmed.slice(pivot + 1) : ''
    }
  }
  return ''
}

export function teacherSessionCookie(sessionId, maxAgeSeconds = 60 * 60 * 12) {
  return `${EDU_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
}

export function clearTeacherSessionCookie() {
  return `${EDU_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export async function authenticateTeacher(store, { email, accessCode }) {
  const teacher = await store.getTeacherByEmail(normalizeTeacherEmail(email))
  if (!teacher || teacher.access_code !== String(accessCode || '')) {
    return null
  }
  return teacher
}

export async function createTeacherSession(store, teacher) {
  const record = buildTeacherSessionRecord({
    teacher_id: teacher.id,
    teacher_name: teacher.name,
    teacher_email: teacher.email,
    provider: 'access-code',
  })
  await store.putTeacherSession(record)
  return record
}

export async function getTeacherSession(store, rawCookieHeader) {
  const sessionId = cookieValue(rawCookieHeader, EDU_SESSION_COOKIE)
  if (!sessionId) {
    return buildTeacherAuthSession({ authenticated: false })
  }

  const record = await store.getTeacherSession(sessionId)
  if (!record) {
    return buildTeacherAuthSession({ authenticated: false })
  }

  if (Date.parse(record.expires_at) <= Date.now()) {
    await store.deleteTeacherSession(sessionId)
    return buildTeacherAuthSession({ authenticated: false })
  }

  return buildTeacherAuthSession({
    authenticated: true,
    teacher_id: record.teacher_id,
    teacher_name: record.teacher_name,
    teacher_email: record.teacher_email,
    provider: record.provider,
  })
}

export async function destroyTeacherSession(store, rawCookieHeader) {
  const sessionId = cookieValue(rawCookieHeader, EDU_SESSION_COOKIE)
  if (sessionId) {
    await store.deleteTeacherSession(sessionId)
  }
}
