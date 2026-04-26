export const LIVE_SESSION_STALE_MS = 15000

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
