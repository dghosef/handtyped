import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_TENANT_ID,
  buildAssignment,
  buildAssignmentAudit,
  buildClassroom,
  buildEduReplay,
  buildLiveReplayEvent,
  buildLiveReplayHead,
  buildLiveSession,
  buildLiveSessionSummary,
  buildTeacher,
  nowIso,
} from './edu-schema.js'

const CLASSROOM_PREFIX = 'edu:classrooms:'
const ASSIGNMENT_PREFIX = 'edu:assignments:'
const LIVE_PREFIX = 'edu:live_sessions:'
const LIVE_SUMMARY_PREFIX = 'edu:live_session_summaries:'
const LIVE_REPLAY_HEAD_PREFIX = 'edu:live_replay_heads:'
const LIVE_REPLAY_EVENT_PREFIX = 'edu:live_replay_events:'
const REPLAY_PREFIX = 'edu:replays:'
const ASSIGNMENT_AUDIT_PREFIX = 'edu:assignment_audits:'
const TEACHER_PREFIX = 'edu:teachers:'
const TEACHER_SESSION_PREFIX = 'edu:teacher_sessions:'
const DASHBOARD_SUMMARY_PREFIX = 'edu:dashboard_summaries:'
const LIVE_SESSION_TTL_DAYS = 30
const LIVE_REPLAY_EVENT_TTL_DAYS = 30
const REPLAY_TTL_DAYS = 180
const AUDIT_TTL_DAYS = 365
const D1_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS edu_records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    json TEXT NOT NULL,
    tenant_id TEXT,
    email TEXT,
    join_code TEXT,
    classroom_id TEXT,
    student_key TEXT,
    parent_id TEXT,
    expires_at TEXT,
    PRIMARY KEY (kind, id)
  )`,
  'CREATE INDEX IF NOT EXISTS edu_records_kind_updated_at ON edu_records(kind, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_updated_at ON edu_records(tenant_id, kind, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_teacher_email ON edu_records(kind, email)',
  'CREATE INDEX IF NOT EXISTS edu_records_join_code ON edu_records(kind, join_code)',
  'CREATE INDEX IF NOT EXISTS edu_records_classroom_id ON edu_records(kind, classroom_id)',
  'CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_join_code ON edu_records(tenant_id, kind, join_code)',
  "CREATE UNIQUE INDEX IF NOT EXISTS edu_records_classroom_join_code_unique ON edu_records(kind, join_code) WHERE kind = 'classroom' AND join_code IS NOT NULL",
  'CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_classroom_id ON edu_records(tenant_id, kind, classroom_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_parent_id ON edu_records(tenant_id, kind, parent_id, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_tenant_kind_student_key ON edu_records(tenant_id, kind, student_key, updated_at DESC)',
  'CREATE INDEX IF NOT EXISTS edu_records_kind_expires_at ON edu_records(kind, expires_at)',
]

function recordUpdatedAt(record) {
  return String(record?.updated_at || nowIso())
}

function normalizeJoinCode(joinCode) {
  return String(joinCode || '').trim().toUpperCase()
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function normalizeTenantId(tenantId) {
  return String(tenantId || DEFAULT_TENANT_ID).trim() || DEFAULT_TENANT_ID
}

function normalizeStudentOverrideKey(studentName) {
  return String(studentName || '').trim().toLowerCase()
}

function cleanStudentName(studentName) {
  return String(studentName || '').replace(/\s+/g, ' ').trim()
}

function studentAliasMap(classroom) {
  return classroom?.student_aliases && typeof classroom.student_aliases === 'object' && !Array.isArray(classroom.student_aliases)
    ? classroom.student_aliases
    : {}
}

function canonicalStudentNameForClassroom(classroom, studentName) {
  const cleanName = cleanStudentName(studentName)
  const key = normalizeStudentOverrideKey(cleanName)
  const alias = key ? cleanStudentName(studentAliasMap(classroom)[key]) : ''
  return alias || cleanName
}

function studentRemovedFromClassroom(classroom, studentName) {
  const key = normalizeStudentOverrideKey(canonicalStudentNameForClassroom(classroom, studentName) || studentName)
  if (!key) {
    return false
  }
  return (Array.isArray(classroom?.removed_students) ? classroom.removed_students : []).some(
    (value) => normalizeStudentOverrideKey(value) === key,
  )
}

function studentAlreadyInClassroom(classroom, studentName) {
  const normalizedStudent = normalizeStudentOverrideKey(studentName)
  return (Array.isArray(classroom?.students) ? classroom.students : []).some(
    (value) => normalizeStudentOverrideKey(value) === normalizedStudent,
  )
}

function mergeById(previous = [], incoming = []) {
  const merged = new Map()
  for (const item of Array.isArray(previous) ? previous : []) {
    if (item?.id) merged.set(item.id, item)
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (item?.id) merged.set(item.id, item)
  }
  return [...merged.values()]
}

function assignmentTargetsStudent(assignment, studentName) {
  const assignedStudents = Array.isArray(assignment?.assigned_students)
    ? assignment.assigned_students.map((value) => String(value || '').trim()).filter(Boolean)
    : []
  if (!assignedStudents.length) {
    return true
  }
  const normalizedStudent = normalizeStudentOverrideKey(studentName)
  if (!normalizedStudent) {
    return true
  }
  return assignedStudents.some((value) => normalizeStudentOverrideKey(value) === normalizedStudent)
}

async function rememberStudentInClassroom(store, classroom, studentName) {
  const normalizedStudent = canonicalStudentNameForClassroom(classroom, studentName)
  if (!normalizedStudent || !classroom) {
    return classroom
  }
  if (studentRemovedFromClassroom(classroom, normalizedStudent)) {
    return null
  }

  const existingStudents = Array.isArray(classroom.students) ? classroom.students : []
  if (studentAlreadyInClassroom(classroom, normalizedStudent)) {
    return classroom
  }

  const updated = buildClassroom({
    ...classroom,
    students: [...existingStudents, normalizedStudent],
    removed_students: (Array.isArray(classroom.removed_students) ? classroom.removed_students : []).filter(
      (value) => normalizeStudentOverrideKey(value) !== normalizeStudentOverrideKey(normalizedStudent),
    ),
    updated_at: nowIso(),
  })
  await store.putClassroom(updated)
  return updated
}

function mapStudentNameList(values, oldName, newName) {
  const oldKey = normalizeStudentOverrideKey(oldName)
  const seen = new Set()
  const next = []
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = normalizeStudentOverrideKey(value) === oldKey ? cleanStudentName(newName) : cleanStudentName(value)
    const key = normalizeStudentOverrideKey(candidate)
    if (candidate && !seen.has(key)) {
      seen.add(key)
      next.push(candidate)
    }
  }
  return next
}

function renameStudentKeyedMap(map, oldName, newName) {
  const oldKey = normalizeStudentOverrideKey(oldName)
  const newKey = normalizeStudentOverrideKey(newName)
  const next = { ...(map || {}) }
  if (oldKey && Object.hasOwn(next, oldKey)) {
    next[newKey] = next[oldKey]
    delete next[oldKey]
  }
  return next
}

function removeStudentKeyedMap(map, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  const next = { ...(map || {}) }
  delete next[key]
  return next
}

function renameStudentRequestEntries(entries, oldName, newName) {
  const oldKey = normalizeStudentOverrideKey(oldName)
  return (Array.isArray(entries) ? entries : []).map((entry) =>
    normalizeStudentOverrideKey(entry?.student_name) === oldKey
      ? { ...entry, student_name: cleanStudentName(newName) }
      : entry,
  )
}

function removeStudentRequestEntries(entries, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  return (Array.isArray(entries) ? entries : []).filter(
    (entry) => normalizeStudentOverrideKey(entry?.student_name) !== key,
  )
}

function assignmentWithRenamedStudent(assignment, oldName, newName) {
  return buildAssignment({
    ...assignment,
    assigned_students: mapStudentNameList(assignment.assigned_students, oldName, newName),
    student_temporary_access_until: renameStudentKeyedMap(assignment.student_temporary_access_until, oldName, newName),
    student_access_revoked: renameStudentKeyedMap(assignment.student_access_revoked, oldName, newName),
    student_access_revoked_until: renameStudentKeyedMap(assignment.student_access_revoked_until, oldName, newName),
    student_access_revoked_rejoin_window: renameStudentKeyedMap(
      assignment.student_access_revoked_rejoin_window,
      oldName,
      newName,
    ),
    student_rejoin_history: renameStudentKeyedMap(assignment.student_rejoin_history, oldName, newName),
    student_overrides: renameStudentKeyedMap(assignment.student_overrides, oldName, newName),
    student_access_requests: renameStudentRequestEntries(assignment.student_access_requests, oldName, newName),
    student_feedback_requests: renameStudentRequestEntries(assignment.student_feedback_requests, oldName, newName),
    updated_at: nowIso(),
  })
}

function assignmentWithoutStudent(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  return buildAssignment({
    ...assignment,
    assigned_students: (Array.isArray(assignment.assigned_students) ? assignment.assigned_students : []).filter(
      (value) => normalizeStudentOverrideKey(value) !== key,
    ),
    student_temporary_access_until: removeStudentKeyedMap(assignment.student_temporary_access_until, studentName),
    student_access_revoked: removeStudentKeyedMap(assignment.student_access_revoked, studentName),
    student_access_revoked_until: removeStudentKeyedMap(assignment.student_access_revoked_until, studentName),
    student_access_revoked_rejoin_window: removeStudentKeyedMap(
      assignment.student_access_revoked_rejoin_window,
      studentName,
    ),
    student_rejoin_history: removeStudentKeyedMap(assignment.student_rejoin_history, studentName),
    student_overrides: removeStudentKeyedMap(assignment.student_overrides, studentName),
    student_access_requests: removeStudentRequestEntries(assignment.student_access_requests, studentName),
    student_feedback_requests: removeStudentRequestEntries(assignment.student_feedback_requests, studentName),
    updated_at: nowIso(),
  })
}

export async function renameClassroomStudent(store, classroom, oldName, newName) {
  const cleanOld = canonicalStudentNameForClassroom(classroom, oldName)
  const cleanNew = cleanStudentName(newName)
  const oldKey = normalizeStudentOverrideKey(cleanOld)
  const newKey = normalizeStudentOverrideKey(cleanNew)
  if (!classroom || !oldKey || !newKey) {
    throw new Error('Both old and new student names are required')
  }
  if (oldKey === newKey) {
    return buildClassroom({ ...classroom, updated_at: nowIso() })
  }

  const aliases = { ...studentAliasMap(classroom), [oldKey]: cleanNew }
  for (const [aliasKey, aliasValue] of Object.entries(aliases)) {
    if (normalizeStudentOverrideKey(aliasValue) === oldKey) {
      aliases[aliasKey] = cleanNew
    }
  }
  const updatedClassroom = buildClassroom({
    ...classroom,
    students: mapStudentNameList(classroom.students, cleanOld, cleanNew),
    removed_students: (Array.isArray(classroom.removed_students) ? classroom.removed_students : []).filter(
      (value) => normalizeStudentOverrideKey(value) !== newKey,
    ),
    student_aliases: aliases,
    updated_at: nowIso(),
  })
  await store.putClassroom(updatedClassroom)

  const assignments = await listAssignmentsByClassroomCompat(store, updatedClassroom)
  for (const assignment of assignments) {
    await store.putAssignment(assignmentWithRenamedStudent(assignment, cleanOld, cleanNew))
  }
  await store.refreshDashboardSummary?.(updatedClassroom.tenant_id)
  return updatedClassroom
}

export async function removeClassroomStudent(store, classroom, studentName) {
  const cleanName = canonicalStudentNameForClassroom(classroom, studentName)
  const key = normalizeStudentOverrideKey(cleanName)
  if (!classroom || !key) {
    throw new Error('Student name is required')
  }
  const aliases = { ...studentAliasMap(classroom) }
  for (const [aliasKey, aliasValue] of Object.entries(aliases)) {
    if (aliasKey === key || normalizeStudentOverrideKey(aliasValue) === key) {
      delete aliases[aliasKey]
    }
  }
  const removedStudents = [
    ...mapStudentNameList(classroom.removed_students, cleanName, cleanName),
    cleanName,
  ].filter(Boolean)
  const updatedClassroom = buildClassroom({
    ...classroom,
    students: (Array.isArray(classroom.students) ? classroom.students : []).filter(
      (value) => normalizeStudentOverrideKey(value) !== key,
    ),
    removed_students: [...new Set(removedStudents.map(cleanStudentName).filter(Boolean))],
    student_aliases: aliases,
    updated_at: nowIso(),
  })
  await store.putClassroom(updatedClassroom)

  const assignments = await listAssignmentsByClassroomCompat(store, updatedClassroom)
  for (const assignment of assignments) {
    await store.putAssignment(assignmentWithoutStudent(assignment, cleanName))
  }
  await store.refreshDashboardSummary?.(updatedClassroom.tenant_id)
  return updatedClassroom
}

function effectiveStudentTemporaryAccessUntil(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  const classUntil = assignment?.temporary_access_until ?? null
  if (!key) {
    return classUntil
  }
  const studentUntil = assignment?.student_temporary_access_until?.[key] ?? null
  const classDate = parseDateOrNull(classUntil)
  const studentDate = parseDateOrNull(studentUntil)
  if (studentDate && (!classDate || studentDate >= classDate)) {
    return studentUntil
  }
  return classUntil
}

function parseDateOrNull(value) {
  if (!value) {
    return null
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function laterDate(left, right) {
  if (!left) {
    return right || null
  }
  if (!right) {
    return left
  }
  return left >= right ? left : right
}

function studentVisibleFeedback(grading) {
  if (!grading || typeof grading !== 'object') {
    return null
  }
  if (grading.feedback_status === 'draft') {
    return null
  }
  return grading
}

function assignmentWindowContainsNow(window, now = new Date()) {
  if (!window) {
    return false
  }
  const startMinutes = (Number(window.start_hour) || 0) * 60 + (Number(window.start_minute) || 0)
  const endMinutes = (Number(window.end_hour) || 0) * 60 + (Number(window.end_minute) || 0)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const overnight = startMinutes > endMinutes
  const anchor = new Date(now)
  if (overnight && nowMinutes <= endMinutes) {
    anchor.setDate(anchor.getDate() - 1)
  }
  const anchorDateKey = `${anchor.getFullYear()}-${String(anchor.getMonth() + 1).padStart(2, '0')}-${String(anchor.getDate()).padStart(2, '0')}`
  if (window.end_date && anchorDateKey > String(window.end_date)) {
    return false
  }
  const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][anchor.getDay()]
  if (!window.days?.[weekday]) {
    return false
  }
  return overnight
    ? nowMinutes >= startMinutes || nowMinutes <= endMinutes
    : nowMinutes >= startMinutes && nowMinutes <= endMinutes
}

function assignmentWindowDeadline(window, now = new Date()) {
  if (!assignmentWindowContainsNow(window, now)) {
    return null
  }
  const startMinutes = (Number(window.start_hour) || 0) * 60 + (Number(window.start_minute) || 0)
  const endMinutes = (Number(window.end_hour) || 0) * 60 + (Number(window.end_minute) || 0)
  const overnight = startMinutes > endMinutes
  const anchor = new Date(now)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  if (overnight && nowMinutes <= endMinutes) {
    anchor.setDate(anchor.getDate() - 1)
  }
  const deadline = new Date(anchor)
  if (overnight) {
    deadline.setDate(deadline.getDate() + 1)
  }
  deadline.setHours(Number(window.end_hour) || 0, Number(window.end_minute) || 0, 0, 0)
  return deadline
}

function windowAnchorDate(window, now = new Date()) {
  const startMinutes = (Number(window?.start_hour) || 0) * 60 + (Number(window?.start_minute) || 0)
  const endMinutes = (Number(window?.end_hour) || 0) * 60 + (Number(window?.end_minute) || 0)
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  const anchor = new Date(now)
  if (startMinutes > endMinutes && nowMinutes <= endMinutes) {
    anchor.setDate(anchor.getDate() - 1)
  }
  anchor.setHours(0, 0, 0, 0)
  return anchor
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function activeAssignmentWindowIdentity(assignment, studentName, now = new Date()) {
  const normalized = buildAssignment(assignment)
  const activeWindows = (normalized.windows || [])
    .map((window, index) => {
      const endAt = assignmentWindowDeadline(window, now)
      if (!endAt) {
        return null
      }
      const anchor = windowAnchorDate(window, now)
      const startAt = new Date(anchor)
      startAt.setHours(Number(window.start_hour) || 0, Number(window.start_minute) || 0, 0, 0)
      const scheduleSignature = [
        window.label || '',
        JSON.stringify(window.days || {}),
        window.end_date || '',
        Number(window.start_hour) || 0,
        Number(window.start_minute) || 0,
        Number(window.end_hour) || 0,
        Number(window.end_minute) || 0,
      ].join('|')
      return {
        key: `window:${dateKey(anchor)}:${index}:${scheduleSignature}`,
        label: window.label || 'Writing window',
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString(),
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.end_at).localeCompare(String(b.end_at)))

  if (activeWindows.length) {
    return activeWindows[0]
  }

  const temporaryUntil = parseDateOrNull(effectiveStudentTemporaryAccessUntil(normalized, studentName))
  if (temporaryUntil && temporaryUntil >= now) {
    return {
      key: `temporary:${temporaryUntil.toISOString()}`,
      label: 'Teacher-granted time',
      start_at: null,
      end_at: temporaryUntil.toISOString(),
    }
  }

  return null
}

function currentRejoinHistory(assignment, studentName, windowIdentity, now = new Date()) {
  const key = normalizeStudentOverrideKey(studentName)
  const existing = key ? assignment?.student_rejoin_history?.[key] : null
  if (existing?.window_key === windowIdentity?.key) {
    return {
      ...existing,
      events: Array.isArray(existing.events) ? existing.events : [],
    }
  }
  return {
    student_name: String(studentName || '').trim(),
    window_key: windowIdentity?.key || `unknown:${now.toISOString()}`,
    window_label: windowIdentity?.label || '',
    window_start_at: windowIdentity?.start_at || null,
    window_end_at: windowIdentity?.end_at || null,
    close_count: 0,
    events: [],
    updated_at: now.toISOString(),
  }
}

function assignmentRequiresRepeatedQuitLockout(assignment) {
  return Boolean(assignment?.policy?.require_lockdown)
}

export function recordStudentAssignmentOpen(assignment, studentName, now = new Date()) {
  const normalized = buildAssignment(assignment)
  const key = normalizeStudentOverrideKey(studentName)
  const windowIdentity = activeAssignmentWindowIdentity(normalized, studentName, now)
  if (!key || !windowIdentity || studentAccessRevokedForAssignment(normalized, studentName, now)) {
    return {
      assignment: normalized,
      recorded: false,
      access_revoked: studentAccessRevokedForAssignment(normalized, studentName, now),
      close_count: normalized.student_rejoin_history?.[key]?.close_count || 0,
      history: normalized.student_rejoin_history?.[key] || null,
    }
  }
  const history = currentRejoinHistory(normalized, studentName, windowIdentity, now)
  const nextHistory = buildAssignment({
    ...normalized,
    student_rejoin_history: {
      ...normalized.student_rejoin_history,
      [key]: {
        ...history,
        events: [
          ...history.events,
          {
            type: 'opened',
            at: now.toISOString(),
            window_key: history.window_key,
          },
        ].slice(-24),
        updated_at: now.toISOString(),
      },
    },
    updated_at: now.toISOString(),
  })
  return {
    assignment: nextHistory,
    recorded: true,
    access_revoked: false,
    close_count: nextHistory.student_rejoin_history[key]?.close_count || 0,
    history: nextHistory.student_rejoin_history[key] || null,
  }
}

export function recordStudentAssignmentClose(assignment, studentName, now = new Date()) {
  const normalized = buildAssignment(assignment)
  const key = normalizeStudentOverrideKey(studentName)
  const windowIdentity = activeAssignmentWindowIdentity(normalized, studentName, now)
  if (!key || !windowIdentity) {
    return {
      assignment: normalized,
      access_revoked: studentAccessRevokedForAssignment(normalized, studentName, now),
      close_count: normalized.student_rejoin_history?.[key]?.close_count || 0,
      history: normalized.student_rejoin_history?.[key] || null,
    }
  }

  const history = currentRejoinHistory(normalized, studentName, windowIdentity, now)
  const closeCount = Math.max(Number(history.close_count) || 0, 0) + 1
  const shouldLock =
    assignmentRequiresRepeatedQuitLockout(normalized) && closeCount >= 2
  const nextStudentAccessRevoked = { ...normalized.student_access_revoked }
  const nextStudentAccessRevokedUntil = { ...normalized.student_access_revoked_until }
  const nextStudentAccessRevokedRejoinWindow = { ...normalized.student_access_revoked_rejoin_window }
  if (shouldLock) {
    nextStudentAccessRevoked[key] = true
    nextStudentAccessRevokedRejoinWindow[key] = history.window_key
    if (history.window_end_at) {
      nextStudentAccessRevokedUntil[key] = history.window_end_at
    }
  }

  const updatedAssignment = buildAssignment({
    ...normalized,
    student_access_revoked: nextStudentAccessRevoked,
    student_access_revoked_until: nextStudentAccessRevokedUntil,
    student_access_revoked_rejoin_window: nextStudentAccessRevokedRejoinWindow,
    student_rejoin_history: {
      ...normalized.student_rejoin_history,
      [key]: {
        ...history,
        close_count: closeCount,
        events: [
          ...history.events,
          {
            type: shouldLock ? 'locked' : 'closed',
            at: now.toISOString(),
            window_key: history.window_key,
          },
        ].slice(-24),
        updated_at: now.toISOString(),
      },
    },
    updated_at: now.toISOString(),
  })
  return {
    assignment: updatedAssignment,
    access_revoked: shouldLock,
    close_count: closeCount,
    history: updatedAssignment.student_rejoin_history[key] || null,
  }
}

export function assignmentWithRejoinHistoryReset(assignment, now = new Date()) {
  const normalized = buildAssignment(assignment)
  const rejoinRevoked = normalized.student_access_revoked_rejoin_window || {}
  const studentAccessRevoked = { ...normalized.student_access_revoked }
  const studentAccessRevokedUntil = { ...normalized.student_access_revoked_until }
  for (const key of Object.keys(rejoinRevoked)) {
    delete studentAccessRevoked[key]
    delete studentAccessRevokedUntil[key]
  }
  return buildAssignment({
    ...normalized,
    student_access_revoked: studentAccessRevoked,
    student_access_revoked_until: studentAccessRevokedUntil,
    student_access_revoked_rejoin_window: {},
    student_rejoin_history: {},
    updated_at: now.toISOString(),
  })
}

export function assignmentTimingFieldsChanged(input = {}) {
  return ['windows', 'temporary_access_until', 'student_temporary_access_until', 'student_overrides'].some((key) =>
    Object.hasOwn(input || {}, key),
  )
}

export function scheduleStateForAssignment(assignment, studentName, now = new Date()) {
  const normalized = buildAssignment(assignment)
  if (assignment?.access_revoked || normalized.access_revoked || studentAccessRevokedForAssignment(normalized, studentName, now)) {
    return { schedule_open: false, session_end_at: null }
  }
  const temporaryUntil = parseDateOrNull(effectiveStudentTemporaryAccessUntil(normalized, studentName))
  const activeTemporaryUntil = temporaryUntil && temporaryUntil >= now ? temporaryUntil : null
  const windowDeadline = (normalized.windows || []).reduce(
    (latest, window) => laterDate(latest, assignmentWindowDeadline(window, now)),
    null,
  )
  const sessionEndAt = laterDate(windowDeadline, activeTemporaryUntil)
  return {
    schedule_open: Boolean(sessionEndAt),
    session_end_at: sessionEndAt ? sessionEndAt.toISOString() : null,
  }
}

async function buildLinkedAssignmentReferences(store, assignment, studentName) {
  const linkedIds = Array.isArray(assignment?.linked_assignment_ids) ? assignment.linked_assignment_ids : []
  const references = []
  for (const linkedId of linkedIds) {
    if (!linkedId || linkedId === assignment.id) {
      continue
    }
    const linkedAssignment = await store.getAssignment(linkedId)
    if (!linkedAssignment) {
      continue
    }
    const liveSession = await store.getLiveSessionForAssignmentStudent(
      linkedAssignment.id,
      studentName,
      linkedAssignment.tenant_id,
    )
    const markdown = String(liveSession?.current_text || '').trim()
    references.push({
      assignment_id: linkedAssignment.id,
      title: linkedAssignment.title,
      course: linkedAssignment.course,
      classroom_name: linkedAssignment.classroom_name ?? null,
      available: Boolean(markdown),
      markdown,
      modified_at: liveSession?.updated_at || liveSession?.last_activity_at || null,
      word_count: markdown ? markdown.split(/\s+/).filter(Boolean).length : 0,
    })
  }
  return references
}

async function getClassroomByJoinCodeCompat(store, joinCode) {
  if (typeof store.getClassroomByJoinCode === 'function') {
    return store.getClassroomByJoinCode(joinCode)
  }
  const normalizedJoinCode = normalizeJoinCode(joinCode)
  const classrooms = await store.listClassrooms?.()
  return (classrooms || []).find((item) => normalizeJoinCode(item?.join_code) === normalizedJoinCode) || null
}

async function listAssignmentsByClassroomCompat(store, classroom) {
  if (!classroom?.id) {
    return []
  }
  if (typeof store.listAssignmentsByClassroomId === 'function') {
    return store.listAssignmentsByClassroomId(classroom.id, classroom.tenant_id)
  }
  const assignments = await store.listAssignments?.()
  return (assignments || []).filter((item) => item?.classroom_id === classroom.id)
}

async function getLiveSessionForAssignmentStudentCompat(store, assignmentId, studentName, tenantId) {
  if (typeof store.getLiveSessionForAssignmentStudent === 'function') {
    return store.getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId)
  }
  const sessions = await store.listLiveSessions?.(tenantId)
  const studentKey = normalizedStudentKey(studentName)
  const matching = (sessions || [])
    .map((item) => buildLiveSession(item))
    .filter((session) => session.assignment_id === assignmentId)
    .filter((session) => normalizedStudentKey(session.student_name) === studentKey)
    .sort((a, b) =>
      String(b.updated_at || b.last_activity_at || '').localeCompare(String(a.updated_at || a.last_activity_at || '')),
    )
  return matching[0] || null
}

function studentAccessRevokedForAssignment(assignment, studentName, now = new Date()) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return false
  }
  if (!assignment?.student_access_revoked?.[key]) {
    return false
  }
  const revokedUntil = parseDateOrNull(assignment?.student_access_revoked_until?.[key])
  return !revokedUntil || revokedUntil >= now
}

function effectiveStudentSettingsOverride(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return null
  }
  const overrides = assignment?.student_overrides
  if (!overrides || typeof overrides !== 'object') {
    return null
  }
  const override = overrides[key]
  return override && typeof override === 'object' ? override : null
}

function studentAccessRequestForAssignment(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return null
  }
  const requests = assignment?.student_access_requests
  if (!requests || typeof requests !== 'object') {
    return null
  }
  const request = requests[key]
  return request && typeof request === 'object' ? request : null
}

function studentFeedbackRequestForAssignment(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return null
  }
  const requests = assignment?.student_feedback_requests
  if (!requests || typeof requests !== 'object') {
    return null
  }
  const request = requests[key]
  return request && typeof request === 'object' ? request : null
}

function assignmentForStudentConfig(assignment, studentName) {
  const normalized = buildAssignment(assignment)
  const override = effectiveStudentSettingsOverride(normalized, studentName)
  const effectiveTemporaryAccessUntil = Object.hasOwn(override || {}, 'temporary_access_until')
    ? override.temporary_access_until
    : effectiveStudentTemporaryAccessUntil(normalized, studentName)
  return {
    ...normalized,
    temporary_access_until: effectiveTemporaryAccessUntil,
    access_revoked: studentAccessRevokedForAssignment(normalized, studentName),
    policy: {
      ...normalized.policy,
      ...(override?.policy || {}),
    },
    editor_policy: {
      ...normalized.editor_policy,
      ...(override?.editor_policy || {}),
    },
    browser_policy: {
      ...normalized.browser_policy,
      ...(override?.browser_policy || {}),
    },
    student_feedback: normalized.student_feedback || null,
    student_access_request: studentAccessRequestForAssignment(normalized, studentName),
    student_feedback_request: studentFeedbackRequestForAssignment(normalized, studentName),
    rejoin_history: normalized.student_rejoin_history?.[normalizeStudentOverrideKey(studentName)] || null,
    student_access_requests: {},
    student_feedback_requests: {},
    student_access_revoked: {},
    student_access_revoked_until: {},
    student_access_revoked_rejoin_window: {},
    student_rejoin_history: {},
    student_temporary_access_until: {},
    student_overrides: {},
  }
}

function normalizedStudentKey(studentName) {
  return normalizeStudentOverrideKey(studentName)
}

function isoDaysFromNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function expiryForKind(kind, record) {
  if (record?.expires_at) {
    return String(record.expires_at)
  }
  switch (kind) {
    case 'teacher_session':
      return String(record?.expires_at || isoDaysFromNow(1))
    case 'live_session':
    case 'live_session_summary':
    case 'live_replay_head':
      return isoDaysFromNow(LIVE_SESSION_TTL_DAYS)
    case 'live_replay_event':
      return isoDaysFromNow(LIVE_REPLAY_EVENT_TTL_DAYS)
    case 'replay':
      return isoDaysFromNow(REPLAY_TTL_DAYS)
    case 'assignment_audit':
      return isoDaysFromNow(AUDIT_TTL_DAYS)
    default:
      return null
  }
}

function studentFeedbackForAssignment(liveSessions, assignmentId, studentName) {
  const studentKey = normalizedStudentKey(studentName)
  if (!assignmentId || !studentKey) {
    return null
  }

  const matching = (liveSessions || [])
    .map((item) => buildLiveSession(item))
    .filter((session) => session.assignment_id === assignmentId)
    .filter((session) => normalizedStudentKey(session.student_name) === studentKey)
    .sort((a, b) =>
      String(b.updated_at || b.last_activity_at || '').localeCompare(String(a.updated_at || a.last_activity_at || '')),
    )

  return matching[0]?.grading || null
}

function sortByUpdatedDesc(items) {
  return [...items].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

function buildDashboardSummaryRecord({
  tenantId = DEFAULT_TENANT_ID,
  classrooms = 0,
  assignments = 0,
  live_sessions = 0,
  replays_available = 0,
  audits_recorded = 0,
  active_students = 0,
  updated_at = nowIso(),
} = {}) {
  return {
    id: `dashboard:${normalizeTenantId(tenantId)}`,
    tenant_id: normalizeTenantId(tenantId),
    classrooms: Number(classrooms || 0),
    assignments: Number(assignments || 0),
    live_sessions: Number(live_sessions || 0),
    replays_available: Number(replays_available || 0),
    audits_recorded: Number(audits_recorded || 0),
    active_students: Number(active_students || 0),
    updated_at,
  }
}

export function createNodeEduStore(baseDir) {
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true })
  }

  function filePath(name) {
    return join(baseDir, `${name}.json`)
  }

  function readCollection(name) {
    const path = filePath(name)
    if (!existsSync(path)) {
      return []
    }
    return JSON.parse(readFileSync(path, 'utf8'))
  }

  function writeCollection(name, value) {
    const path = filePath(name)
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tempPath, JSON.stringify(value, null, 2))
    renameSync(tempPath, path)
  }

  function filterByTenant(items, tenantId = DEFAULT_TENANT_ID) {
    if (tenantId == null) {
      return items
    }
    const normalizedTenant = normalizeTenantId(tenantId)
    return items.filter((item) => normalizeTenantId(item?.tenant_id) === normalizedTenant)
  }

  return {
    async listClassrooms(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('classrooms'), tenantId))
    },
    async putClassroom(classroom) {
      classroom = buildClassroom(classroom)
      const classrooms = readCollection('classrooms')
      const next = classrooms.filter((item) => item.id !== classroom.id)
      next.push(classroom)
      writeCollection('classrooms', next)
    },
    async getClassroom(id) {
      return readCollection('classrooms').find((item) => item.id === id) || null
    },
    async deleteClassroom(id) {
      const classrooms = readCollection('classrooms')
      writeCollection(
        'classrooms',
        classrooms.filter((item) => item.id !== id),
      )
    },
    async listAssignments(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('assignments'), tenantId))
    },
    async putAssignment(assignment) {
      assignment = buildAssignment(assignment)
      const assignments = readCollection('assignments')
      const next = assignments.filter((item) => item.id !== assignment.id)
      next.push(assignment)
      writeCollection('assignments', next)
    },
    async getAssignment(id) {
      return readCollection('assignments').find((item) => item.id === id) || null
    },
    async deleteAssignment(id) {
      const assignments = readCollection('assignments')
      writeCollection(
        'assignments',
        assignments.filter((item) => item.id !== id),
      )
    },
    async listTeachers(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('teachers'), tenantId))
    },
    async putTeacher(teacher) {
      teacher = buildTeacher(teacher)
      const teachers = readCollection('teachers')
      const next = teachers.filter((item) => item.id !== teacher.id)
      next.push(teacher)
      writeCollection('teachers', next)
    },
    async getTeacherByEmail(email, tenantId = null) {
      const teachers = readCollection('teachers')
      const scoped = tenantId ? filterByTenant(teachers, tenantId) : teachers
      return scoped.find((item) => item.email === email) || null
    },
    async deleteTeacher(id) {
      const teachers = readCollection('teachers')
      writeCollection(
        'teachers',
        teachers.filter((item) => item.id !== id),
      )
    },
    async putTeacherSession(session) {
      const sessions = readCollection('teacher_sessions')
      const next = sessions.filter((item) => item.id !== session.id)
      next.push(session)
      writeCollection('teacher_sessions', next)
    },
    async getTeacherSession(id) {
      return readCollection('teacher_sessions').find((item) => item.id === id) || null
    },
    async deleteTeacherSession(id) {
      const sessions = readCollection('teacher_sessions')
      writeCollection(
        'teacher_sessions',
        sessions.filter((item) => item.id !== id),
      )
    },
    async listLiveSessions(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('live_sessions'), tenantId))
    },
    async putLiveSession(session) {
      session = buildLiveSession(session)
      const summary = buildLiveSessionSummary(session)
      const sessions = readCollection('live_sessions')
      const next = sessions.filter((item) => item.id !== session.id)
      next.push(session)
      writeCollection('live_sessions', next)

      const summaries = readCollection('live_session_summaries')
      const nextSummaries = summaries.filter((item) => item.id !== summary.id)
      nextSummaries.push(summary)
      writeCollection('live_session_summaries', nextSummaries)
      writeCollection(
        'dashboard_summaries',
        mergeById(readCollection('dashboard_summaries'), [
          buildDashboardSummaryRecord({
            tenantId: session.tenant_id,
            classrooms: readCollection('classrooms').filter((item) => item.tenant_id === session.tenant_id).length,
            assignments: readCollection('assignments').filter((item) => item.tenant_id === session.tenant_id).length,
            live_sessions: next.filter((item) => item.tenant_id === session.tenant_id).length,
            replays_available: readCollection('replays').filter((item) => item.tenant_id === session.tenant_id).length,
            audits_recorded: readCollection('assignment_audits').filter((item) => item.tenant_id === session.tenant_id).length,
            active_students: next.filter((item) => item.tenant_id === session.tenant_id).length,
          }),
        ]),
      )
    },
    async getLiveSession(id) {
      return readCollection('live_sessions').find((item) => item.id === id) || null
    },
    async listLiveSessionSummariesForAssignment(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('live_session_summaries'), tenantId)).filter(
        (item) => item.assignment_id === assignmentId,
      )
    },
    async listLiveReplayHeads(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('live_replay_heads'), tenantId))
    },
    async putLiveReplayHead(head) {
      const heads = readCollection('live_replay_heads')
      const next = heads.filter((item) => item.id !== head.id)
      next.push(buildLiveReplayHead(head))
      writeCollection('live_replay_heads', next)
    },
    async getLiveReplayHead(id) {
      const item = readCollection('live_replay_heads').find((entry) => entry.id === id)
      return item ? buildLiveReplayHead(item) : null
    },
    async listLiveReplayEvents(liveSessionId, tenantId = DEFAULT_TENANT_ID) {
      return filterByTenant(readCollection('live_replay_events'), tenantId)
        .filter((item) => item.live_session_id === liveSessionId)
        .map((item) => buildLiveReplayEvent(item))
        .sort((a, b) => a.seq - b.seq || String(a.updated_at).localeCompare(String(b.updated_at)))
    },
    async appendLiveReplayEvent(event) {
      const events = readCollection('live_replay_events')
      events.push(buildLiveReplayEvent(event))
      writeCollection('live_replay_events', events)
    },
    async listReplays(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('replays'), tenantId))
    },
    async putReplay(replay) {
      replay = buildEduReplay(replay)
      const replays = readCollection('replays')
      const next = replays.filter((item) => item.id !== replay.id)
      next.push(replay)
      writeCollection('replays', next)
    },
    async getReplay(id) {
      return readCollection('replays').find((item) => item.id === id) || null
    },
    async listAssignmentAudits(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(readCollection('assignment_audits'), tenantId))
    },
    async putAssignmentAudit(audit) {
      audit = buildAssignmentAudit(audit)
      const audits = readCollection('assignment_audits')
      const next = audits.filter((item) => item.id !== audit.id)
      next.push(audit)
      writeCollection('assignment_audits', next)
    },
    async getClassroomByJoinCode(joinCode) {
      const normalizedJoinCode = normalizeJoinCode(joinCode)
      return readCollection('classrooms').find((item) => normalizeJoinCode(item.join_code) === normalizedJoinCode) || null
    },
    async listAssignmentsByClassroomId(classroomId, tenantId = DEFAULT_TENANT_ID) {
      return (await this.listAssignments(tenantId)).filter((item) => item.classroom_id === classroomId)
    },
    async listAssignmentAuditsByAssignmentId(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return (await this.listAssignmentAudits(tenantId)).filter((item) => item.assignment_id === assignmentId)
    },
    async getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId = DEFAULT_TENANT_ID) {
      const studentKey = normalizedStudentKey(studentName)
      return (
        (await this.listLiveSessions(tenantId)).find(
          (item) => item.assignment_id === assignmentId && normalizedStudentKey(item.student_name) === studentKey,
        ) || null
      )
    },
    async putDashboardSummary(summary) {
      const item = buildDashboardSummaryRecord(summary)
      const summaries = readCollection('dashboard_summaries')
      const next = summaries.filter((entry) => entry.id !== item.id)
      next.push(item)
      writeCollection('dashboard_summaries', next)
    },
    async getDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      const id = `dashboard:${normalizeTenantId(tenantId)}`
      return readCollection('dashboard_summaries').find((item) => item.id === id) || null
    },
    async refreshDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      const [classrooms, assignments, liveSessions, replays, audits] = await Promise.all([
        this.listClassrooms(tenantId),
        this.listAssignments(tenantId),
        this.listLiveSessions(tenantId),
        this.listReplays(tenantId),
        this.listAssignmentAudits(tenantId),
      ])
      const summary = buildDashboardSummaryRecord({
        tenantId,
        classrooms: classrooms.length,
        assignments: assignments.length,
        live_sessions: liveSessions.length,
        replays_available: replays.length,
        audits_recorded: audits.length,
        active_students: liveSessions.length,
      })
      await this.putDashboardSummary(summary)
      return summary
    },
    async runMaintenance() {
      return false
    },
  }
}

export function createKvEduStore(kv) {
  async function listByPrefix(prefix) {
    const response = await kv.list({ prefix })
    const items = []
    for (const key of response.keys || []) {
      const raw = await kv.get(key.name)
      if (raw) {
        items.push(JSON.parse(raw))
      }
    }
    return items
  }

  function filterByTenant(items, tenantId = DEFAULT_TENANT_ID) {
    if (tenantId == null) {
      return items
    }
    const normalizedTenant = normalizeTenantId(tenantId)
    return items.filter((item) => normalizeTenantId(item?.tenant_id) === normalizedTenant)
  }

  return {
    async listClassrooms(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(CLASSROOM_PREFIX), tenantId))
    },
    async putClassroom(classroom) {
      classroom = buildClassroom(classroom)
      await kv.put(`${CLASSROOM_PREFIX}${classroom.id}`, JSON.stringify(classroom))
    },
    async getClassroom(id) {
      const raw = await kv.get(`${CLASSROOM_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteClassroom(id) {
      await kv.delete(`${CLASSROOM_PREFIX}${id}`)
    },
    async listAssignments(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(ASSIGNMENT_PREFIX), tenantId))
    },
    async putAssignment(assignment) {
      assignment = buildAssignment(assignment)
      await kv.put(`${ASSIGNMENT_PREFIX}${assignment.id}`, JSON.stringify(assignment))
    },
    async getAssignment(id) {
      const raw = await kv.get(`${ASSIGNMENT_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteAssignment(id) {
      await kv.delete(`${ASSIGNMENT_PREFIX}${id}`)
    },
    async listTeachers(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(TEACHER_PREFIX), tenantId))
    },
    async putTeacher(teacher) {
      teacher = buildTeacher(teacher)
      await kv.put(`${TEACHER_PREFIX}${teacher.id}`, JSON.stringify(teacher))
    },
    async getTeacherByEmail(email, tenantId = null) {
      const teachers = await listByPrefix(TEACHER_PREFIX)
      const scoped = tenantId ? filterByTenant(teachers, tenantId) : teachers
      return scoped.find((item) => item.email === email) || null
    },
    async deleteTeacher(id) {
      await kv.delete(`${TEACHER_PREFIX}${id}`)
    },
    async putTeacherSession(session) {
      await kv.put(`${TEACHER_SESSION_PREFIX}${session.id}`, JSON.stringify(session))
    },
    async getTeacherSession(id) {
      const raw = await kv.get(`${TEACHER_SESSION_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async deleteTeacherSession(id) {
      await kv.delete(`${TEACHER_SESSION_PREFIX}${id}`)
    },
    async listLiveSessions(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(LIVE_PREFIX), tenantId))
    },
    async putLiveSession(session) {
      session = buildLiveSession(session)
      const summary = buildLiveSessionSummary(session)
      await kv.put(`${LIVE_PREFIX}${session.id}`, JSON.stringify(session))
      await kv.put(`${LIVE_SUMMARY_PREFIX}${session.assignment_id}:${session.id}`, JSON.stringify(summary))
      await this.refreshDashboardSummary(session.tenant_id)
    },
    async getLiveSession(id) {
      const raw = await kv.get(`${LIVE_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async listLiveSessionSummariesForAssignment(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(`${LIVE_SUMMARY_PREFIX}${assignmentId}:`), tenantId))
    },
    async listLiveReplayHeads(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(LIVE_REPLAY_HEAD_PREFIX), tenantId))
    },
    async putLiveReplayHead(head) {
      await kv.put(`${LIVE_REPLAY_HEAD_PREFIX}${head.id}`, JSON.stringify(buildLiveReplayHead(head)))
    },
    async getLiveReplayHead(id) {
      const raw = await kv.get(`${LIVE_REPLAY_HEAD_PREFIX}${id}`)
      return raw ? buildLiveReplayHead(JSON.parse(raw)) : null
    },
    async listLiveReplayEvents(liveSessionId, tenantId = DEFAULT_TENANT_ID) {
      const items = filterByTenant(await listByPrefix(`${LIVE_REPLAY_EVENT_PREFIX}${liveSessionId}:`), tenantId)
      return items.map((item) => buildLiveReplayEvent(item)).sort((a, b) => a.seq - b.seq)
    },
    async appendLiveReplayEvent(event) {
      const normalized = buildLiveReplayEvent(event)
      await kv.put(
        `${LIVE_REPLAY_EVENT_PREFIX}${normalized.live_session_id}:${String(normalized.seq).padStart(8, '0')}`,
        JSON.stringify(normalized),
      )
    },
    async listReplays(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(REPLAY_PREFIX), tenantId))
    },
    async putReplay(replay) {
      replay = buildEduReplay(replay)
      await kv.put(`${REPLAY_PREFIX}${replay.id}`, JSON.stringify(replay))
    },
    async getReplay(id) {
      const raw = await kv.get(`${REPLAY_PREFIX}${id}`)
      return raw ? JSON.parse(raw) : null
    },
    async listAssignmentAudits(tenantId = DEFAULT_TENANT_ID) {
      return sortByUpdatedDesc(filterByTenant(await listByPrefix(ASSIGNMENT_AUDIT_PREFIX), tenantId))
    },
    async putAssignmentAudit(audit) {
      audit = buildAssignmentAudit(audit)
      await kv.put(`${ASSIGNMENT_AUDIT_PREFIX}${audit.id}`, JSON.stringify(audit))
    },
    async getClassroomByJoinCode(joinCode) {
      const normalizedJoinCode = normalizeJoinCode(joinCode)
      const classrooms = await listByPrefix(CLASSROOM_PREFIX)
      return classrooms.find((item) => normalizeJoinCode(item.join_code) === normalizedJoinCode) || null
    },
    async listAssignmentsByClassroomId(classroomId, tenantId = DEFAULT_TENANT_ID) {
      return (await this.listAssignments(tenantId)).filter((item) => item.classroom_id === classroomId)
    },
    async listAssignmentAuditsByAssignmentId(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return (await this.listAssignmentAudits(tenantId)).filter((item) => item.assignment_id === assignmentId)
    },
    async getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId = DEFAULT_TENANT_ID) {
      const studentKey = normalizedStudentKey(studentName)
      return (
        (await this.listLiveSessions(tenantId)).find(
          (item) => item.assignment_id === assignmentId && normalizedStudentKey(item.student_name) === studentKey,
        ) || null
      )
    },
    async putDashboardSummary(summary) {
      const item = buildDashboardSummaryRecord(summary)
      await kv.put(`${DASHBOARD_SUMMARY_PREFIX}${item.tenant_id}`, JSON.stringify(item))
    },
    async getDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      const raw = await kv.get(`${DASHBOARD_SUMMARY_PREFIX}${normalizeTenantId(tenantId)}`)
      return raw ? JSON.parse(raw) : null
    },
    async refreshDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      const [classrooms, assignments, liveSessions, replays, audits] = await Promise.all([
        this.listClassrooms(tenantId),
        this.listAssignments(tenantId),
        this.listLiveSessions(tenantId),
        this.listReplays(tenantId),
        this.listAssignmentAudits(tenantId),
      ])
      const summary = buildDashboardSummaryRecord({
        tenantId,
        classrooms: classrooms.length,
        assignments: assignments.length,
        live_sessions: liveSessions.length,
        replays_available: replays.length,
        audits_recorded: audits.length,
        active_students: liveSessions.length,
      })
      await this.putDashboardSummary(summary)
      return summary
    },
    async runMaintenance() {
      return false
    },
  }
}

export function createD1EduStore(db) {
  let schemaReady = null
  let maintenanceRanAt = 0

  function hydrateRow(row) {
    if (!row) {
      return null
    }
    const parsed = JSON.parse(row.json)
    return {
      ...parsed,
      tenant_id: parsed?.tenant_id || row.tenant_id || DEFAULT_TENANT_ID,
      classroom_id: parsed?.classroom_id || row.classroom_id || parsed?.assignment_id || null,
      student_key: parsed?.student_key || row.student_key || null,
      parent_id: parsed?.parent_id || row.parent_id || parsed?.live_session_id || parsed?.replay_session_id || null,
      expires_at: Object.hasOwn(parsed || {}, 'expires_at') ? parsed.expires_at : row.expires_at ?? null,
    }
  }

  async function schemaColumns() {
    const response = await db.prepare('PRAGMA table_info(edu_records)').all()
    return new Set((response.results || []).map((row) => String(row.name || '')))
  }

  async function ensureColumn(name, sqlType) {
    const columns = await schemaColumns()
    if (!columns.has(name)) {
      await db.prepare(`ALTER TABLE edu_records ADD COLUMN ${name} ${sqlType}`).run()
    }
  }

  async function backfillLegacyColumns() {
    await db
      .prepare(
        `UPDATE edu_records
         SET tenant_id = COALESCE(NULLIF(tenant_id, ''), NULLIF(json_extract(json, '$.tenant_id'), ''), ?),
             classroom_id = COALESCE(
               NULLIF(classroom_id, ''),
               NULLIF(json_extract(json, '$.classroom_id'), ''),
               NULLIF(json_extract(json, '$.assignment_id'), '')
             ),
             student_key = COALESCE(
               NULLIF(student_key, ''),
               lower(trim(COALESCE(json_extract(json, '$.student_name'), '')))
             ),
             parent_id = COALESCE(
               NULLIF(parent_id, ''),
               NULLIF(json_extract(json, '$.live_session_id'), ''),
               NULLIF(json_extract(json, '$.replay_session_id'), '')
             )
         WHERE tenant_id IS NULL
            OR tenant_id = ''
            OR classroom_id IS NULL
            OR classroom_id = ''
            OR student_key IS NULL
            OR student_key = ''
            OR parent_id IS NULL
            OR parent_id = ''`,
      )
      .bind(DEFAULT_TENANT_ID)
      .run()
  }

  async function ensureSchema() {
    if (!schemaReady) {
      schemaReady = (async () => {
        await db.prepare(D1_SCHEMA_STATEMENTS[0]).run()
        await ensureColumn('tenant_id', 'TEXT')
        await ensureColumn('student_key', 'TEXT')
        await ensureColumn('parent_id', 'TEXT')
        await ensureColumn('expires_at', 'TEXT')
        for (const statement of D1_SCHEMA_STATEMENTS.slice(1)) {
          await db.prepare(statement).run()
        }
        await backfillLegacyColumns()
      })()
    }
    await schemaReady
  }

  async function listKind(kind, tenantId = DEFAULT_TENANT_ID) {
    await ensureSchema()
    if (tenantId == null) {
      const response = await db
        .prepare(
          'SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? ORDER BY updated_at DESC, id DESC',
        )
        .bind(kind)
        .all()
      return (response.results || []).map((row) => hydrateRow(row))
    }
    const response = await db
      .prepare(
        'SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? ORDER BY updated_at DESC, id DESC',
      )
      .bind(normalizeTenantId(tenantId), kind)
      .all()
    return (response.results || []).map((row) => hydrateRow(row))
  }

  async function getByKindAndId(kind, id) {
    await ensureSchema()
    const row = await db
      .prepare('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND id = ? LIMIT 1')
      .bind(kind, id)
      .first()
    return row ? hydrateRow(row) : null
  }

  async function getByKindAndJoinCode(kind, joinCode) {
    await ensureSchema()
    const row = await db
      .prepare('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND join_code = ? LIMIT 1')
      .bind(kind, normalizeJoinCode(joinCode))
      .first()
    return row ? hydrateRow(row) : null
  }

  async function listKindByClassroom(kind, classroomId, tenantId = DEFAULT_TENANT_ID) {
    await ensureSchema()
    const response = await db
      .prepare(
        'SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? ORDER BY updated_at DESC, id DESC',
      )
      .bind(normalizeTenantId(tenantId), kind, classroomId)
      .all()
    return (response.results || []).map((row) => hydrateRow(row))
  }

  async function listKindByParent(kind, parentId, tenantId = DEFAULT_TENANT_ID) {
    await ensureSchema()
    const response = await db
      .prepare(
        'SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND parent_id = ? ORDER BY updated_at DESC, id DESC',
      )
      .bind(normalizeTenantId(tenantId), kind, parentId)
      .all()
    return (response.results || []).map((row) => hydrateRow(row))
  }

  async function getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId = DEFAULT_TENANT_ID) {
    await ensureSchema()
    const row = await db
      .prepare(
        'SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND classroom_id = ? AND student_key = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      )
      .bind(normalizeTenantId(tenantId), 'live_session', assignmentId, normalizedStudentKey(studentName))
      .first()
    return row ? hydrateRow(row) : null
  }

  async function putRecord(kind, id, record, extras = {}) {
    await ensureSchema()
    await db
      .prepare(
        `INSERT INTO edu_records (
           kind, id, updated_at, json, tenant_id, email, join_code, classroom_id, student_key, parent_id, expires_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, id) DO UPDATE SET
           updated_at = excluded.updated_at,
           json = excluded.json,
           tenant_id = excluded.tenant_id,
           email = excluded.email,
           join_code = excluded.join_code,
           classroom_id = excluded.classroom_id,
           student_key = excluded.student_key,
           parent_id = excluded.parent_id,
           expires_at = excluded.expires_at`,
      )
      .bind(
        kind,
        id,
        recordUpdatedAt(record),
        JSON.stringify(record),
        normalizeTenantId(extras.tenant_id || record?.tenant_id),
        extras.email || null,
        extras.join_code || null,
        extras.classroom_id || null,
        extras.student_key || null,
        extras.parent_id || null,
        extras.expires_at ?? expiryForKind(kind, record),
      )
      .run()
  }

  async function recomputeDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
    const [classrooms, assignments, liveSessions, replays, audits] = await Promise.all([
      listKind('classroom', tenantId),
      listKind('assignment', tenantId),
      listKind('live_session', tenantId),
      listKind('replay', tenantId),
      listKind('assignment_audit', tenantId),
    ])
    const summary = buildDashboardSummaryRecord({
      tenantId,
      classrooms: classrooms.length,
      assignments: assignments.length,
      live_sessions: liveSessions.length,
      replays_available: replays.length,
      audits_recorded: audits.length,
      active_students: liveSessions.length,
    })
    await putRecord('dashboard_summary', summary.id, summary, {
      tenant_id: summary.tenant_id,
    })
    return summary
  }

  async function performMaintenance({ force = false } = {}) {
    const now = Date.now()
    if (!force && now - maintenanceRanAt < 60_000) {
      return false
    }
    maintenanceRanAt = now
    await ensureSchema()
    await db.prepare('DELETE FROM edu_records WHERE expires_at IS NOT NULL AND expires_at < ?').bind(nowIso()).run()
    return true
  }

  return {
    async listClassrooms(tenantId = DEFAULT_TENANT_ID) {
      return listKind('classroom', tenantId)
    },
    async putClassroom(classroom) {
      classroom = buildClassroom(classroom)
      await putRecord('classroom', classroom.id, classroom, {
        tenant_id: classroom.tenant_id,
        join_code: normalizeJoinCode(classroom.join_code),
      })
      await recomputeDashboardSummary(classroom.tenant_id)
    },
    async getClassroom(id) {
      return getByKindAndId('classroom', id)
    },
    async deleteClassroom(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('classroom', id).run()
    },
    async getClassroomByJoinCode(joinCode) {
      return getByKindAndJoinCode('classroom', joinCode)
    },
    async listAssignments(tenantId = DEFAULT_TENANT_ID) {
      return listKind('assignment', tenantId)
    },
    async putAssignment(assignment) {
      assignment = buildAssignment(assignment)
      await putRecord('assignment', assignment.id, assignment, {
        tenant_id: assignment.tenant_id,
        classroom_id: assignment.classroom_id || null,
      })
      await recomputeDashboardSummary(assignment.tenant_id)
    },
    async getAssignment(id) {
      return getByKindAndId('assignment', id)
    },
    async deleteAssignment(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('assignment', id).run()
    },
    async listAssignmentsByClassroomId(classroomId, tenantId = DEFAULT_TENANT_ID) {
      return listKindByClassroom('assignment', classroomId, tenantId)
    },
    async listTeachers(tenantId = DEFAULT_TENANT_ID) {
      return listKind('teacher', tenantId)
    },
    async putTeacher(teacher) {
      teacher = buildTeacher(teacher)
      await putRecord('teacher', teacher.id, teacher, {
        tenant_id: teacher.tenant_id,
        email: normalizeEmail(teacher.email),
      })
    },
    async getTeacherByEmail(email, tenantId = null) {
      await ensureSchema()
      if (!tenantId) {
        const row = await db
          .prepare('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE kind = ? AND email = ? LIMIT 1')
          .bind('teacher', normalizeEmail(email))
          .first()
        return row ? hydrateRow(row) : null
      }
      const row = await db
        .prepare('SELECT json, tenant_id, classroom_id, student_key, parent_id, expires_at FROM edu_records WHERE tenant_id = ? AND kind = ? AND email = ? LIMIT 1')
        .bind(normalizeTenantId(tenantId), 'teacher', normalizeEmail(email))
        .first()
      return row ? hydrateRow(row) : null
    },
    async deleteTeacher(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('teacher', id).run()
    },
    async putTeacherSession(session) {
      await putRecord('teacher_session', session.id, session, {
        tenant_id: session.tenant_id,
      })
    },
    async getTeacherSession(id) {
      return getByKindAndId('teacher_session', id)
    },
    async deleteTeacherSession(id) {
      await ensureSchema()
      await db.prepare('DELETE FROM edu_records WHERE kind = ? AND id = ?').bind('teacher_session', id).run()
    },
    async listLiveSessions(tenantId = DEFAULT_TENANT_ID) {
      return listKind('live_session', tenantId)
    },
    async putLiveSession(session) {
      session = buildLiveSession(session)
      const summary = buildLiveSessionSummary(session)
      await putRecord('live_session', session.id, session, {
        tenant_id: session.tenant_id,
        classroom_id: session.assignment_id || null,
        student_key: normalizedStudentKey(session.student_name),
      })
      await putRecord('live_session_summary', summary.id, summary, {
        tenant_id: summary.tenant_id,
        classroom_id: summary.assignment_id || null,
        student_key: normalizedStudentKey(summary.student_name),
      })
    },
    async getLiveSession(id) {
      return getByKindAndId('live_session', id)
    },
    async getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId = DEFAULT_TENANT_ID) {
      return getLiveSessionForAssignmentStudent(assignmentId, studentName, tenantId)
    },
    async listLiveSessionSummariesForAssignment(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return listKindByClassroom('live_session_summary', assignmentId, tenantId)
    },
    async listLiveReplayHeads(tenantId = DEFAULT_TENANT_ID) {
      return listKind('live_replay_head', tenantId)
    },
    async putLiveReplayHead(head) {
      const normalized = buildLiveReplayHead(head)
      await putRecord('live_replay_head', normalized.id, normalized, {
        tenant_id: normalized.tenant_id,
        classroom_id: normalized.assignment_id || null,
        parent_id: normalized.live_session_id || null,
        student_key: normalizedStudentKey(normalized.student_name),
      })
    },
    async getLiveReplayHead(id) {
      return getByKindAndId('live_replay_head', id)
    },
    async listLiveReplayEvents(liveSessionId, tenantId = DEFAULT_TENANT_ID) {
      return (await listKindByParent('live_replay_event', liveSessionId, tenantId))
        .map((row) => buildLiveReplayEvent(row))
        .sort((a, b) => a.seq - b.seq || String(a.updated_at).localeCompare(String(b.updated_at)))
    },
    async appendLiveReplayEvent(event) {
      const normalized = buildLiveReplayEvent(event)
      await putRecord('live_replay_event', normalized.id, normalized, {
        tenant_id: normalized.tenant_id,
        classroom_id: normalized.assignment_id || null,
        parent_id: normalized.live_session_id || null,
        student_key: normalizedStudentKey(normalized.student_name),
      })
    },
    async listReplays(tenantId = DEFAULT_TENANT_ID) {
      return listKind('replay', tenantId)
    },
    async putReplay(replay) {
      replay = buildEduReplay(replay)
      await putRecord('replay', replay.id, replay, {
        tenant_id: replay.tenant_id,
        classroom_id: replay.assignment_id || null,
        parent_id: replay.live_session_id || null,
        student_key: normalizedStudentKey(replay.student_name),
      })
      await recomputeDashboardSummary(replay.tenant_id)
    },
    async getReplay(id) {
      return getByKindAndId('replay', id)
    },
    async listAssignmentAudits(tenantId = DEFAULT_TENANT_ID) {
      return listKind('assignment_audit', tenantId)
    },
    async putAssignmentAudit(audit) {
      audit = buildAssignmentAudit(audit)
      await putRecord('assignment_audit', audit.id, audit, {
        tenant_id: audit.tenant_id,
        classroom_id: audit.assignment_id || null,
      })
      await recomputeDashboardSummary(audit.tenant_id)
    },
    async listAssignmentAuditsByAssignmentId(assignmentId, tenantId = DEFAULT_TENANT_ID) {
      return listKindByClassroom('assignment_audit', assignmentId, tenantId)
    },
    async putDashboardSummary(summary) {
      const item = buildDashboardSummaryRecord(summary)
      await putRecord('dashboard_summary', item.id, item, {
        tenant_id: item.tenant_id,
      })
    },
    async getDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      return getByKindAndId('dashboard_summary', `dashboard:${normalizeTenantId(tenantId)}`)
    },
    async refreshDashboardSummary(tenantId = DEFAULT_TENANT_ID) {
      return recomputeDashboardSummary(tenantId)
    },
    async runMaintenance(options = {}) {
      return performMaintenance(options)
    },
  }
}

export async function ensureEduSeedData(store) {
  const tenantId = DEFAULT_TENANT_ID
  const classrooms = await store.listClassrooms(tenantId)
  const assignments = await store.listAssignments(tenantId)
  const liveSessions = await store.listLiveSessions(tenantId)
  const teachers = await store.listTeachers(tenantId)

  for (const teacher of teachers) {
    if (teacher?.id === 'teacher_default') {
      await store.deleteTeacher?.(teacher.id)
    }
  }

  if (classrooms.length || assignments.length || liveSessions.length) {
    return
  }

  const classroomOne = buildClassroom({
    tenant_id: tenantId,
    id: 'period-1',
    name: 'English 11 - Period 1',
    join_code: 'P1EN11',
    teacher_name: 'Joseph Tan',
    students: ['Ava L.', 'Mason R.'],
  })
  const classroomTwo = buildClassroom({
    tenant_id: tenantId,
    id: 'period-3',
    name: 'English 11 - Period 3',
    join_code: 'P3EN11',
    teacher_name: 'Joseph Tan',
    students: ['Nina T.', 'Leo C.'],
  })

  await store.putClassroom(classroomOne)
  await store.putClassroom(classroomTwo)

  const assignmentOne = buildAssignment({
    tenant_id: tenantId,
    id: 'gatsby-close-reading',
    title: 'Gatsby Close Reading',
    course: 'English 11',
    classroom_id: classroomOne.id,
    classroom_name: classroomOne.name,
    prompt: 'Write an in-class essay responding to the assigned reading.',
    instructions: 'Use only this computer. Build your argument from memory and class notes.',
    browser_policy: {
      browser_enabled: true,
      home_url: '',
      allowed_domains: [],
      log_all_navigation: true,
    },
  })
  const assignmentTwo = buildAssignment({
    tenant_id: tenantId,
    id: 'macbeth-timed-essay',
    title: 'Macbeth Timed Essay',
    course: 'English 11',
    classroom_id: classroomTwo.id,
    classroom_name: classroomTwo.name,
    prompt: 'Explain how ambition reshapes Macbeth over the course of the play.',
    instructions: 'No outside materials. Cite from memory only.',
    browser_policy: {
      browser_enabled: false,
      home_url: '',
      allowed_domains: [],
      log_all_navigation: true,
    },
  })

  await store.putAssignment(assignmentOne)
  await store.putAssignment(assignmentTwo)

  await store.putLiveSession(
    buildLiveSession({
      tenant_id: tenantId,
      id: 'live_ava',
      assignment_id: assignmentOne.id,
      assignment_title: assignmentOne.title,
      course: assignmentOne.course,
      classroom: classroomOne.name,
      student_name: 'Ava L.',
      current_text: 'Nick becomes credible because he sees wealth from both inside and outside the circle.',
      current_url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
      violation_count: 0,
      replay_session_id: 'edu_replay_ava',
    }),
  )
  await store.putLiveSession(
    buildLiveSession({
      tenant_id: tenantId,
      id: 'live_mason',
      assignment_id: assignmentTwo.id,
      assignment_title: assignmentTwo.title,
      course: assignmentTwo.course,
      classroom: classroomTwo.name,
      student_name: 'Mason R.',
      current_text: 'Macbeth treats prophecy as permission, and that choice turns fear into policy.',
      current_url: null,
      violation_count: 1,
      violations: [{ t: Date.now() * 1_000_000, kind: 'focus_lost', detail: 'Student app lost focus once.' }],
    }),
  )
  await store.putReplay(
    buildEduReplay({
      tenant_id: tenantId,
      id: 'edu_replay_ava',
      live_session_id: 'live_ava',
      assignment_id: assignmentOne.id,
      assignment_title: assignmentOne.title,
      course: assignmentOne.course,
      classroom: classroomOne.name,
      student_name: 'Ava L.',
      current_text:
        'Nick becomes credible because he sees wealth from both inside and outside the circle.',
      document_history: [{ op: 'insert', text: 'Nick becomes credible because he sees wealth.' }],
      current_url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
      url_history: [
        {
          t: Date.now() * 1_000_000,
          url: 'https://www.gutenberg.org/files/64317/64317-h/64317-h.htm',
          allowed: true,
          source: 'seed',
        },
      ],
    }),
  )
  await store.refreshDashboardSummary?.(tenantId)
}

export async function buildEduDashboard(store, tenantId = DEFAULT_TENANT_ID) {
  const classrooms = await store.listClassrooms(tenantId)
  const assignments = await store.listAssignments(tenantId)
  const liveSessions = await store.listLiveSessions(tenantId)
  const assignmentAudits = await store.listAssignmentAudits(tenantId)
  const summary = (await store.getDashboardSummary?.(tenantId)) || (await store.refreshDashboardSummary?.(tenantId))

  return {
    updated_at: summary?.updated_at || nowIso(),
    product: {
      host: 'edu.handtyped.app',
      teacher_surface: 'web',
      student_surface: 'native',
      student_runtime: 'native-app',
    },
    summary: summary || buildDashboardSummaryRecord({ tenantId, classrooms: classrooms.length, assignments: assignments.length }),
    classrooms,
    assignments,
    live_sessions: liveSessions,
    assignment_audits: assignmentAudits,
    architecture: {
      teacher_web_origin: 'https://edu.handtyped.app',
      replay_origin: 'https://replay.handtyped.app',
      student_delivery: 'native desktop app',
    },
  }
}

export async function buildAssignmentLiveSummaries(store, assignmentId) {
  const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
  const tenantId = assignment?.tenant_id || DEFAULT_TENANT_ID
  return (await store.listLiveSessionSummariesForAssignment(assignmentId, tenantId)).map((item) =>
    buildLiveSessionSummary(item),
  )
}

export async function buildEduDashboardDelta(store, tenantId = DEFAULT_TENANT_ID, { since } = {}) {
  const normalizedSince = String(since || '')
  const classrooms = await store.listClassrooms(tenantId)
  const assignments = await store.listAssignments(tenantId)
  const liveSessions = await store.listLiveSessions(tenantId)
  const assignmentAudits = await store.listAssignmentAudits(tenantId)
  const summary = (await store.getDashboardSummary?.(tenantId)) || (await store.refreshDashboardSummary?.(tenantId))

  const changedSince = (items) =>
    (items || []).filter((item) => String(item.updated_at || '') > normalizedSince)

  return {
    updated_at: summary?.updated_at || nowIso(),
    since: normalizedSince || null,
    classrooms,
    assignments,
    live_sessions: liveSessions,
    replays: [],
    assignment_audits: changedSince(assignmentAudits),
    summary: summary || buildDashboardSummaryRecord({ tenantId, classrooms: classrooms.length, assignments: assignments.length }),
  }
}

export function buildAssignmentAuditRecord({
  action,
  assignment,
  previousAssignment = null,
  actor = null,
}) {
  const nextSnapshot = assignment ? buildAssignment(assignment) : null
  const previousSnapshot = previousAssignment ? buildAssignment(previousAssignment) : null
  const changes = []

  function pushChange(label, before, after) {
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return
    }
    changes.push({ label, before, after })
  }

  if (action === 'created' && nextSnapshot) {
    changes.push({ label: 'Assignment created', before: null, after: nextSnapshot.title })
  } else if (action === 'deleted' && previousSnapshot) {
    changes.push({ label: 'Assignment deleted', before: previousSnapshot.title, after: null })
  } else if (previousSnapshot && nextSnapshot) {
    pushChange('Title', previousSnapshot.title, nextSnapshot.title)
    pushChange('Prompt', previousSnapshot.prompt, nextSnapshot.prompt)
    pushChange('Instructions', previousSnapshot.instructions, nextSnapshot.instructions)
    pushChange('Writing windows', previousSnapshot.windows, nextSnapshot.windows)
    pushChange('Temporary access until', previousSnapshot.temporary_access_until, nextSnapshot.temporary_access_until)
    pushChange(
      'Student extensions',
      previousSnapshot.student_temporary_access_until,
      nextSnapshot.student_temporary_access_until,
    )
    pushChange('Blocked students', previousSnapshot.student_access_revoked, nextSnapshot.student_access_revoked)
    pushChange('Access requests', previousSnapshot.student_access_requests, nextSnapshot.student_access_requests)
    pushChange('Feedback requests', previousSnapshot.student_feedback_requests, nextSnapshot.student_feedback_requests)
    pushChange('Student setting overrides', previousSnapshot.student_overrides, nextSnapshot.student_overrides)
    pushChange('Assigned students', previousSnapshot.assigned_students, nextSnapshot.assigned_students)
    pushChange('Rules', previousSnapshot.policy, nextSnapshot.policy)
    pushChange('Writing defaults', previousSnapshot.editor_policy, nextSnapshot.editor_policy)
    pushChange('Browser policy', previousSnapshot.browser_policy, nextSnapshot.browser_policy)
    pushChange('Linked assignments', previousSnapshot.linked_assignment_ids, nextSnapshot.linked_assignment_ids)
    pushChange('Rubric', previousSnapshot.rubric, nextSnapshot.rubric)
  }

  const summary =
    action === 'created'
      ? `Created assignment "${assignment?.title || previousAssignment?.title || 'Untitled assignment'}"`
      : action === 'deleted'
        ? `Deleted assignment "${previousAssignment?.title || assignment?.title || 'Untitled assignment'}"`
        : changes.length
          ? `Updated ${changes.length} setting${changes.length === 1 ? '' : 's'}`
          : 'Reviewed assignment settings'

  return buildAssignmentAudit({
    tenant_id: assignment?.tenant_id || previousAssignment?.tenant_id || DEFAULT_TENANT_ID,
    assignment_id: assignment?.id || previousAssignment?.id || '',
    classroom_id: assignment?.classroom_id || previousAssignment?.classroom_id || null,
    assignment_title: assignment?.title || previousAssignment?.title || '',
    action,
    actor_id: actor?.teacher_id || null,
    actor_name: actor?.teacher_name || null,
    actor_email: actor?.teacher_email || null,
    summary,
    changes,
    snapshot: nextSnapshot || previousSnapshot,
  })
}

export async function buildStudentConfig(store, { joinCode, studentName, joining = false } = {}) {
  let classroom = await getClassroomByJoinCodeCompat(store, joinCode)
  if (!classroom) {
    return { classroom: null, assignments: [], canonical_student_name: null }
  }
  const canonicalStudentName = canonicalStudentNameForClassroom(classroom, studentName)
  if (studentRemovedFromClassroom(classroom, canonicalStudentName)) {
    return { classroom: null, assignments: [], canonical_student_name: canonicalStudentName || null }
  }
  if (joining && studentAlreadyInClassroom(classroom, canonicalStudentName)) {
    return {
      classroom: null,
      assignments: [],
      canonical_student_name: canonicalStudentName || null,
      duplicate_student_name: true,
    }
  }
  classroom = await rememberStudentInClassroom(store, classroom, canonicalStudentName)
  if (!classroom) {
    return { classroom: null, assignments: [], canonical_student_name: canonicalStudentName || null }
  }
  const assignments = (await listAssignmentsByClassroomCompat(store, classroom))
    .filter((item) => assignmentTargetsStudent(item, canonicalStudentName))
  const assignmentsWithFeedback = await Promise.all(
    assignments.map(async (item) => {
      const liveSession = await getLiveSessionForAssignmentStudentCompat(store, item.id, canonicalStudentName, classroom.tenant_id)
      return assignmentForStudentConfig(
        {
          ...item,
          student_feedback: studentVisibleFeedback(liveSession?.grading) || item?.student_feedback || null,
        },
        canonicalStudentName,
      )
    }),
  )
  return { classroom, assignments: assignmentsWithFeedback, canonical_student_name: canonicalStudentName || null }
}

export async function buildStudentAssignmentConfig(
  store,
  {
    assignmentId,
    joinCode,
    studentName,
  } = {},
) {
  const assignment = assignmentId ? await store.getAssignment(assignmentId) : null
  if (!assignment) {
    return { classroom: null, assignment: null }
  }

  const classroom = assignment.classroom_id ? await store.getClassroom(assignment.classroom_id) : null
  if (!classroom) {
    return { classroom: null, assignment: null }
  }

  if (String(classroom.join_code || '').toUpperCase() !== String(joinCode || '').toUpperCase()) {
    return { classroom: null, assignment: null }
  }

  const canonicalStudentName = canonicalStudentNameForClassroom(classroom, studentName)
  if (studentRemovedFromClassroom(classroom, canonicalStudentName)) {
    return { classroom: null, assignment: null, canonical_student_name: canonicalStudentName || null }
  }

  if (!assignmentTargetsStudent(assignment, canonicalStudentName)) {
    return { classroom, assignment: null }
  }

  const liveSession = await getLiveSessionForAssignmentStudentCompat(
    store,
    assignment.id,
    canonicalStudentName,
    assignment.tenant_id,
  )
  return {
    classroom,
    canonical_student_name: canonicalStudentName || null,
    assignment: assignmentForStudentConfig(
      {
        ...assignment,
        student_feedback: studentVisibleFeedback(liveSession?.grading) || assignment?.student_feedback || null,
      },
      canonicalStudentName,
    ),
  }
}

export async function buildStudentActiveAssignmentState(
  store,
  {
    assignmentId,
    joinCode,
    studentName,
  } = {},
) {
  const result = await buildStudentAssignmentConfig(store, {
    assignmentId,
    joinCode,
    studentName,
  })
  if (!result.classroom || !result.assignment) {
    return {
      classroom: result.classroom || null,
      assignment: null,
      linked_references: [],
      schedule_open: false,
      session_end_at: null,
    }
  }
  const schedule = scheduleStateForAssignment(result.assignment, studentName)
  return {
    classroom: result.classroom,
    assignment: result.assignment,
    linked_references: await buildLinkedAssignmentReferences(store, result.assignment, studentName),
    schedule_open: schedule.schedule_open,
    session_end_at: schedule.session_end_at,
  }
}
