import {
  DEFAULT_TENANT_ID,
  buildTeacher,
  buildTeacherAuthSession,
  buildTeacherSessionRecord,
  normalizeTeacherEmail,
} from './edu-schema.js'
import { verifyTeacherPassword } from './edu-password.js'

export const EDU_SESSION_COOKIE = 'edu_teacher_session'

function randomTenantId() {
  if (globalThis.crypto?.randomUUID) {
    return `tenant_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
  return `tenant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function isLegacyDefaultTeacherAccount(teacher) {
  return teacher?.id === 'teacher_default'
}

async function ensureTeacherHasPrivateTenant(store, teacher) {
  if (!teacher || teacher.tenant_id !== DEFAULT_TENANT_ID || isLegacyDefaultTeacherAccount(teacher)) {
    return teacher
  }
  const updatedTeacher = buildTeacher({
    ...teacher,
    tenant_id: randomTenantId(),
    updated_at: new Date().toISOString(),
  })
  await store.putTeacher(updatedTeacher)
  return updatedTeacher
}

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

export async function authenticateTeacher(store, { email, accessCode, password }) {
  const teacher = await store.getTeacherByEmail(normalizeTeacherEmail(email))
  if (!teacher || isLegacyDefaultTeacherAccount(teacher)) {
    return null
  }

  if (typeof password === 'string' && password.length > 0) {
    return verifyTeacherPassword(teacher, password) ? ensureTeacherHasPrivateTenant(store, teacher) : null
  }

  if (teacher.access_code !== String(accessCode || '')) {
    return null
  }

  return ensureTeacherHasPrivateTenant(store, teacher)
}

export async function authenticateTeacherWithGoogle(store, profile) {
  const normalizedEmail = normalizeTeacherEmail(profile?.email)
  const googleSubject = String(profile?.sub || '')
  if (!normalizedEmail || !googleSubject) {
    return null
  }

  const teacher = await store.getTeacherByEmail(normalizedEmail)
  if (!teacher || isLegacyDefaultTeacherAccount(teacher)) {
    if (isLegacyDefaultTeacherAccount(teacher)) {
      await store.deleteTeacher?.(teacher.id)
    }
    const nextTeacher = buildTeacher({
      tenant_id: randomTenantId(),
      name: String(profile?.name || '').trim() || normalizedEmail,
      email: normalizedEmail,
      google_subject: googleSubject,
      password: `${googleSubject}:${normalizedEmail}:${Date.now()}`,
      access_code: '',
    })
    await store.putTeacher(nextTeacher)
    return nextTeacher
  }

  if (teacher.google_subject && teacher.google_subject !== googleSubject) {
    return null
  }

  if (!teacher.google_subject) {
    const updatedTeacher = {
      ...teacher,
      google_subject: googleSubject,
      updated_at: new Date().toISOString(),
    }
    await store.putTeacher(updatedTeacher)
    return ensureTeacherHasPrivateTenant(store, updatedTeacher)
  }

  return ensureTeacherHasPrivateTenant(store, teacher)
}

export async function createTeacherAccount(store, { name, email, password }) {
  const normalizedEmail = normalizeTeacherEmail(email)
  const normalizedPassword = String(password || '')
  const normalizedName = String(name || '').trim()
  if (!normalizedEmail || !normalizedPassword || !normalizedName) {
    throw new Error('Name, email, and password are required')
  }
  if (normalizedPassword.length < 8) {
    throw new Error('Password must be at least 8 characters')
  }
  const existing = await store.getTeacherByEmail(normalizedEmail)
  if (existing) {
    throw new Error('A teacher account with that email already exists')
  }
  const teacher = buildTeacher({
    tenant_id: randomTenantId(),
    name: normalizedName,
    email: normalizedEmail,
    password: normalizedPassword,
    access_code: normalizedPassword,
  })
  await store.putTeacher(teacher)
  return teacher
}

export async function createTeacherSession(store, teacher, provider = 'password') {
  const record = buildTeacherSessionRecord({
    tenant_id: teacher.tenant_id,
    teacher_id: teacher.id,
    teacher_name: teacher.name,
    teacher_email: teacher.email,
    provider,
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

  if (isLegacyDefaultTeacherAccount({ id: record.teacher_id })) {
    await store.deleteTeacherSession(sessionId)
    return buildTeacherAuthSession({ authenticated: false })
  }

  if (Date.parse(record.expires_at) <= Date.now()) {
    await store.deleteTeacherSession(sessionId)
    return buildTeacherAuthSession({ authenticated: false })
  }

  let teacher = null
  if (record.teacher_email) {
    teacher = await store.getTeacherByEmail(record.teacher_email)
  }
  if (teacher && record.teacher_id && teacher.id !== record.teacher_id) {
    teacher = null
  }
  if (teacher) {
    teacher = await ensureTeacherHasPrivateTenant(store, teacher)
    if (
      teacher.tenant_id !== record.tenant_id ||
      teacher.name !== record.teacher_name ||
      teacher.email !== record.teacher_email
    ) {
      const updatedRecord = buildTeacherSessionRecord({
        ...record,
        tenant_id: teacher.tenant_id,
        teacher_name: teacher.name,
        teacher_email: teacher.email,
      })
      await store.putTeacherSession(updatedRecord)
      return buildTeacherAuthSession({
        authenticated: true,
        tenant_id: updatedRecord.tenant_id || null,
        teacher_id: updatedRecord.teacher_id,
        teacher_name: updatedRecord.teacher_name,
        teacher_email: updatedRecord.teacher_email,
        provider: updatedRecord.provider,
      })
    }
  }

  return buildTeacherAuthSession({
    authenticated: true,
    tenant_id: record.tenant_id || null,
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
