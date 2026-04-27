export const LIVE_SESSION_STALE_MS = 15000
export const RECENT_EDIT_WINDOW_MS = 5 * 60 * 1000
export const RECENT_EDIT_BUCKET_MS = 60 * 1000

export function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? null : parsed
}

export function isSessionActive(session, now = Date.now()) {
  if (!session?.schedule_open) {
    return false
  }
  const lastActivityAt = parseTimestamp(session.last_activity_at || session.updated_at)
  if (!lastActivityAt) {
    return false
  }
  return now - lastActivityAt <= LIVE_SESSION_STALE_MS
}

export function sessionStatusLabel(session, now = Date.now()) {
  if (!isSessionActive(session, now)) {
    return 'Offline'
  }
  return session.focused ? 'Focused' : 'Unfocused'
}

export function sessionsForAssignment(sessions, classroomName, assignmentId) {
  return (sessions || []).filter(
    (session) => session.assignment_id === assignmentId && session.classroom === classroomName,
  )
}

function numericHistoryTimes(session) {
  return (session?.document_history || [])
    .map((entry) => Number(entry?.t))
    .filter((value) => Number.isFinite(value) && value >= 0)
}

export function recentEditActivity(
  session,
  {
    windowMs = RECENT_EDIT_WINDOW_MS,
    bucketMs = RECENT_EDIT_BUCKET_MS,
  } = {},
) {
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs))
  const buckets = Array.from({ length: bucketCount }, () => 0)
  const times = numericHistoryTimes(session)
  if (!times.length) {
    return { totalEdits: 0, buckets, latestT: null }
  }

  const latestT = Math.max(...times)
  let totalEdits = 0

  times.forEach((t) => {
    const ageMs = latestT - t
    if (ageMs < 0 || ageMs > windowMs) {
      return
    }
    totalEdits += 1
    const reversedIndex = Math.min(bucketCount - 1, Math.floor(ageMs / bucketMs))
    const bucketIndex = bucketCount - 1 - reversedIndex
    buckets[bucketIndex] += 1
  })

  return { totalEdits, buckets, latestT }
}

export function aggregateRecentEditActivity(
  sessions,
  {
    windowMs = RECENT_EDIT_WINDOW_MS,
    bucketMs = RECENT_EDIT_BUCKET_MS,
  } = {},
) {
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs))
  const totals = Array.from({ length: bucketCount }, () => 0)
  let totalEdits = 0
  let activeStudents = 0

  for (const session of sessions || []) {
    const activity = recentEditActivity(session, { windowMs, bucketMs })
    totalEdits += activity.totalEdits
    if (activity.totalEdits > 0) {
      activeStudents += 1
    }
    activity.buckets.forEach((count, index) => {
      totals[index] += count
    })
  }

  return {
    totalEdits,
    activeStudents,
    buckets: totals,
  }
}

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

export function todayAtLocalTime(hour, minute = 0, now = new Date()) {
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  return target
}

export function localDateTimeInputValue(date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}T${padDatePart(
    date.getHours(),
  )}:${padDatePart(date.getMinutes())}`
}

export function todayAtLocalTimeIso(hour, minute = 0, now = new Date()) {
  return todayAtLocalTime(hour, minute, now).toISOString()
}

export function reconcileTeacherNavigation({
  classrooms = [],
  assignments = [],
  selectedClassroomId = null,
  selectedAssignmentId = null,
  currentView = 'classes',
} = {}) {
  const view = ['classes', 'assignments', 'assignment'].includes(currentView) ? currentView : 'classes'
  const classroomExists = classrooms.some((classroom) => classroom.id === selectedClassroomId)
  const nextClassroomId = classroomExists ? selectedClassroomId : null
  const visibleAssignments = nextClassroomId
    ? assignments.filter((assignment) => assignment.classroom_id === nextClassroomId)
    : []
  const assignmentExists = visibleAssignments.some((assignment) => assignment.id === selectedAssignmentId)
  let nextAssignmentId = assignmentExists ? selectedAssignmentId : null
  let nextView = view

  if (!nextClassroomId) {
    nextView = 'classes'
    nextAssignmentId = null
  } else if (nextView === 'assignment' && !nextAssignmentId) {
    nextView = 'assignments'
  } else if (nextView === 'classes') {
    nextAssignmentId = null
  }

  return {
    selectedClassroomId: nextClassroomId,
    selectedAssignmentId: nextAssignmentId,
    currentView: nextView,
  }
}

export function activeSessionsForAssignment(sessions, classroomName, assignmentId, now = Date.now()) {
  return sessionsForAssignment(sessions, classroomName, assignmentId).filter((session) =>
    isSessionActive(session, now),
  )
}

export function assignmentViewMeta(selectedAssignment, selectedClassroom, sessions, now = Date.now()) {
  if (!selectedAssignment || !selectedClassroom) {
    return ''
  }
  const activeSessions = activeSessionsForAssignment(
    sessions,
    selectedClassroom.name,
    selectedAssignment.id,
    now,
  )
  return `${selectedAssignment.course || selectedClassroom.name} • ${activeSessions.length} active student${
    activeSessions.length === 1 ? '' : 's'
  }`
}

function countFocusLeaves(session) {
  return (session.focus_events || []).filter((event) => {
    const state = String(event?.state || '').toLowerCase()
    return state && state !== 'focused' && state !== 'foreground'
  }).length
}

export function deriveSessionRisk(session, now = Date.now()) {
  const reasons = []
  let score = 0
  const active = isSessionActive(session, now)
  const status = sessionStatusLabel(session, now)
  const violationCount = Number(session?.violation_count || session?.violations?.length || 0)
  const focusLeaves = countFocusLeaves(session)

  if (!active) {
    score += 55
    reasons.push('Offline or stale')
  }
  if (active && !session?.focused) {
    score += 35
    reasons.push('Student is unfocused')
  }
  if (violationCount > 0) {
    score += Math.min(35, 12 + violationCount * 6)
    reasons.push(`${violationCount} violation${violationCount === 1 ? '' : 's'}`)
  }
  if (focusLeaves > 0) {
    score += Math.min(20, focusLeaves * 4)
    reasons.push(`${focusLeaves} focus change${focusLeaves === 1 ? '' : 's'}`)
  }
  if (!session?.hid_active) {
    score += 15
    reasons.push('HID inactive')
  }
  if ((session?.current_text || '').trim().length === 0) {
    score += 6
    reasons.push('No current writing')
  }

  return {
    score,
    reasons,
    status,
    needsAttention: score >= 35 || violationCount > 0 || (active && !session?.focused),
    violationCount,
    focusLeaves,
    active,
  }
}

export function sortSessionsForDisplay(sessions, now = Date.now()) {
  return [...(sessions || [])].sort((a, b) => {
    const riskDelta = deriveSessionRisk(b, now).score - deriveSessionRisk(a, now).score
    if (riskDelta !== 0) {
      return riskDelta
    }
    return String(b.last_activity_at || b.updated_at || '').localeCompare(
      String(a.last_activity_at || a.updated_at || ''),
    )
  })
}

export function timeAgoLabel(value, now = Date.now()) {
  const parsed = parseTimestamp(value)
  if (!parsed) {
    return 'Unknown'
  }
  const deltaSeconds = Math.max(0, Math.floor((now - parsed) / 1000))
  if (deltaSeconds < 5) return 'just now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatWindowSummary(assignment) {
  const window = assignment?.windows?.[0]
  if (!window) {
    return 'No writing window configured.'
  }

  const activeDays = Object.entries(window.days || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([day]) => day.slice(0, 3))
  const start = `${String(window.start_hour ?? 0).padStart(2, '0')}:${String(window.start_minute ?? 0).padStart(2, '0')}`
  const end = `${String(window.end_hour ?? 0).padStart(2, '0')}:${String(window.end_minute ?? 0).padStart(2, '0')}`
  const daysLabel = activeDays.length ? activeDays.join(', ') : 'No days selected'
  const endDate = window.end_date ? ` until ${window.end_date}` : ''
  return `${daysLabel} • ${start}–${end}${endDate}`
}
