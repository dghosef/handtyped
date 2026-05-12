export const LIVE_SESSION_STALE_MS = 15000
export const RECENT_EDIT_WINDOW_MS = 5 * 60 * 1000
export const RECENT_EDIT_BUCKET_MS = 60 * 1000
export const REVIEW_DRAFT_LARGE_DOC_CHARS = 50_000

export function reviewDraftRenderMode(text, largeDocChars = REVIEW_DRAFT_LARGE_DOC_CHARS) {
  return String(text || '').length >= largeDocChars ? 'plain' : 'rich'
}

export function reviewDraftRenderSignature({
  text = '',
  annotationVersion = '',
  highlightVersion = '',
  mode = reviewDraftRenderMode(text),
} = {}) {
  return [
    mode,
    String(text || '').length,
    String(text || ''),
    String(annotationVersion || ''),
    String(highlightVersion || ''),
  ].join('\u001f')
}

export function shouldRenderReviewDraftSurface(previousSignature, nextInput = {}) {
  return previousSignature !== reviewDraftRenderSignature(nextInput)
}

export function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? null : parsed
}

export function sessionPresenceTimestamp(session) {
  const lastActivityAt = parseTimestamp(session?.last_activity_at)
  const updatedAt = parseTimestamp(session?.updated_at)
  return Math.max(lastActivityAt || 0, updatedAt || 0) || null
}

export function isSessionActive(session, now = Date.now()) {
  if (!session?.schedule_open) {
    return false
  }
  const presenceAt = sessionPresenceTimestamp(session)
  if (!presenceAt) {
    return false
  }
  return now - presenceAt <= LIVE_SESSION_STALE_MS
}

export function sessionStatusLabel(session, now = Date.now()) {
  if (!isSessionActive(session, now)) {
    return 'Offline'
  }
  return session.focused ? 'Focused' : 'Unfocused'
}

export function sessionsForAssignment(sessions, classroomName, assignmentId) {
  if (!assignmentId) {
    return []
  }
  return (sessions || []).filter((session) => session.assignment_id === assignmentId)
}

export function dashboardDeltaNeedsFullRefresh(currentState, delta) {
  if (!currentState || !delta?.summary) {
    return false
  }

  const currentLiveCount = Array.isArray(currentState.live_sessions) ? currentState.live_sessions.length : 0
  const currentAuditCount = Array.isArray(currentState.assignment_audits) ? currentState.assignment_audits.length : 0
  const nextLiveCount = Number(delta.summary.live_sessions)
  const nextAuditCount = Number(delta.summary.audits_recorded)

  return (
    Number.isFinite(nextLiveCount) && nextLiveCount < currentLiveCount ||
    Number.isFinite(nextAuditCount) && nextAuditCount < currentAuditCount
  )
}

function historyEntryIsDocumentEdit(entry) {
  if (!entry || typeof entry !== 'object') {
    return false
  }
  if (typeof entry.ins === 'string' && entry.ins.length > 0) {
    return true
  }
  if (typeof entry.del === 'string' && entry.del.length > 0) {
    return true
  }
  if (Number.isFinite(Number(entry.del)) && Number(entry.del) > 0) {
    return true
  }
  return Boolean(entry.marks || entry.formatting || entry.format || entry.style || entry.attrs)
}

function applyDocumentHistoryEntry(text, entry) {
  if (!entry || typeof entry !== 'object') {
    return text
  }
  if (Object.hasOwn(entry, 'text') || Object.hasOwn(entry, 'snapshot')) {
    return String(entry.text ?? entry.snapshot ?? '')
  }
  const chars = Array.from(String(text || ''))
  const pos = Math.max(0, Math.min(chars.length, Number(entry.pos ?? chars.length) || 0))
  const insertText = String(entry.ins ?? '')
  let deleteCount = 0
  if (typeof entry.del === 'string') {
    deleteCount = Array.from(entry.del).length
  } else if (Number.isFinite(Number(entry.del))) {
    deleteCount = Math.max(0, Number(entry.del) || 0)
  }
  chars.splice(pos, deleteCount, ...Array.from(insertText))
  return chars.join('')
}

function applyDocumentHistoryTail(text, tail = []) {
  return (tail || []).reduce((current, entry) => applyDocumentHistoryEntry(current, entry), String(text || ''))
}

function documentEditHistory(session) {
  return (Array.isArray(session?.document_history) ? session.document_history : [])
    .filter((entry) => historyEntryIsDocumentEdit(entry))
}

function numericHistoryTimes(session) {
  return documentEditHistory(session)
    .map((entry) => Number(entry?.t))
    .filter((value) => Number.isFinite(value) && value >= 0)
}

function numericHistoryWallTimes(session) {
  const history = documentEditHistory(session)
  const relativeTimes = numericHistoryTimes(session)
  if (!relativeTimes.length) {
    return history
      .map((entry) => Number(entry?.absolute_wall_ms))
      .filter((value) => Number.isFinite(value) && value > 0)
  }
  const latestRelativeT = Math.max(...relativeTimes)
  const anchorWallMs = Math.max(
    parseTimestamp(session?.last_activity_at) || 0,
    parseTimestamp(session?.updated_at) || 0,
  )
  if (!anchorWallMs) {
    return history
      .map((entry) => Number(entry?.absolute_wall_ms))
      .filter((value) => Number.isFinite(value) && value > 0)
  }

  return history
    .map((entry) => {
      const absoluteWallMs = Number(entry?.absolute_wall_ms)
      if (Number.isFinite(absoluteWallMs) && absoluteWallMs > 0) {
        return absoluteWallMs
      }
      const relativeT = Number(entry?.t)
      if (!Number.isFinite(relativeT) || relativeT < 0) {
        return null
      }
      return anchorWallMs - (latestRelativeT - relativeT)
    })
    .filter((value) => Number.isFinite(value) && value > 0)
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

  if (!times.length && Number.isFinite(Number(session?.recent_edit_count))) {
    const totalEdits = Math.max(0, Number(session.recent_edit_count))
    return {
      totalEdits,
      buckets: [totalEdits],
      latestT: totalEdits > 0 ? totalEdits : null,
    }
  }
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

export function recentEditActivityCurve(
  session,
  {
    windowMs = RECENT_EDIT_WINDOW_MS,
    sampleMs = 5000,
    nowMs = Date.now(),
  } = {},
) {
  const sampleCount = Math.max(1, Math.ceil(windowMs / sampleMs))
  const points = Array.from({ length: sampleCount }, () => 0)
  const wallTimes = numericHistoryWallTimes(session)

  if (!wallTimes.length && Number.isFinite(Number(session?.recent_edit_count))) {
    const totalEdits = Math.max(0, Number(session.recent_edit_count))
    points[points.length - 1] = totalEdits
    return {
      totalEdits,
      points,
      latestT: totalEdits > 0 ? totalEdits : null,
    }
  }
  if (!wallTimes.length) {
    return { totalEdits: 0, points, latestT: null }
  }

  const latestT = Math.max(...wallTimes)
  const rawWindowEnd = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const windowEnd = Math.ceil(rawWindowEnd / sampleMs) * sampleMs
  const windowStart = windowEnd - windowMs
  const recentTimes = wallTimes.filter((t) => t >= windowStart && t <= rawWindowEnd)

  points.forEach((_, index) => {
    const bucketStart = windowStart + (index * sampleMs)
    const bucketEnd = index === points.length - 1 ? windowEnd : bucketStart + sampleMs
    points[index] = recentTimes.some((t) => (
      t >= bucketStart && (index === points.length - 1 ? t <= bucketEnd : t < bucketEnd)
    )) ? 1 : 0
  })

  return {
    totalEdits: recentTimes.length,
    points,
    latestT,
  }
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

export function applyLiveReplayUpdates(baseReplay, updates) {
  const replay = {
    ...(baseReplay || {}),
    ...(updates || {}),
  }
  const existingHistory = Array.isArray(baseReplay?.document_history) ? baseReplay.document_history : []
  const existingUrlHistory = Array.isArray(baseReplay?.url_history) ? baseReplay.url_history : []
  const events = Array.isArray(updates?.events) ? updates.events : []

  replay.document_history = [...existingHistory]
  replay.url_history = [...existingUrlHistory]

  const eventHistoryEntryWallMs = (event, entry) => {
    const explicitWallMs = Number(entry?.absolute_wall_ms)
    if (Number.isFinite(explicitWallMs) && explicitWallMs > 0) {
      return explicitWallMs
    }
    const tail = Array.isArray(event?.document_history_tail) ? event.document_history_tail : []
    const anchorWallMs = Date.parse(event?.last_activity_at || event?.updated_at || event?.created_at || '')
    if (!Number.isFinite(anchorWallMs)) {
      return null
    }
    const tailTimes = tail
      .map((item) => Number(item?.t))
      .filter((value) => Number.isFinite(value))
    if (!tailTimes.length) {
      return anchorWallMs
    }
    const maxTailTime = Math.max(...tailTimes)
    const entryTime = Number(entry?.t)
    return anchorWallMs - maxTailTime + (Number.isFinite(entryTime) ? entryTime : maxTailTime)
  }

  for (const event of events) {
    if (Array.isArray(event?.document_history_tail) && event.document_history_tail.length) {
      replay.document_history.push(
        ...event.document_history_tail.map((entry) => {
          const absoluteWallMs = eventHistoryEntryWallMs(event, entry)
          return {
            ...entry,
            ...(Number.isFinite(absoluteWallMs) ? { absolute_wall_ms: absoluteWallMs } : {}),
          }
        }),
      )
      if (typeof event?.current_text !== 'string') {
        replay.current_text = applyDocumentHistoryTail(replay.current_text, event.document_history_tail)
      }
    }
    if (Array.isArray(event?.url_history_tail) && event.url_history_tail.length) {
      replay.url_history.push(...event.url_history_tail)
    }
    if (typeof event?.current_text === 'string') {
      replay.current_text = event.current_text
    }
    if (Object.hasOwn(event || {}, 'current_url')) {
      replay.current_url = event.current_url ?? null
    }
    if (Object.hasOwn(event || {}, 'current_url_title')) {
      replay.current_url_title = event.current_url_title ?? null
    }
    if (event?.last_activity_at) {
      replay.last_activity_at = event.last_activity_at
    }
  }

  replay.last_seq = Math.max(
    Number(baseReplay?.last_seq ?? 0) || 0,
    Number(updates?.last_seq ?? 0) || 0,
  )
  replay.events = []
  return replay
}

function padDatePart(value) {
  return String(value).padStart(2, '0')
}

function replayShiftedDate(absoluteMs, offsetMinutes = 0) {
  return new Date(Number(absoluteMs || 0) + Number(offsetMinutes || 0) * 60_000)
}

function parseDateInputParts(dateInput) {
  const match = String(dateInput || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }
  return { year, month, day }
}

function replayAbsoluteMsForDateTime(dateInput, hour = 0, minute = 0, offsetMinutes = 0, second = 0, millisecond = 0) {
  const parts = parseDateInputParts(dateInput)
  if (!parts) {
    return null
  }
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Number(hour) || 0,
    Number(minute) || 0,
    Number(second) || 0,
    Number(millisecond) || 0,
  ) - Number(offsetMinutes || 0) * 60_000
}

function replayDayKeyForDateInput(dateInput) {
  const parts = parseDateInputParts(dateInput)
  if (!parts) {
    return null
  }
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  ]
}

export function todayAtLocalTime(hour, minute = 0, now = new Date()) {
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  return target
}

export function nextLocalTimeAtOrAfter(hour, minute = 0, now = new Date()) {
  const target = todayAtLocalTime(hour, minute, now)
  if (target.getTime() >= now.getTime()) {
    return target
  }
  const next = new Date(target)
  next.setDate(next.getDate() + 1)
  return next
}

export function localDateTimeInputValue(date) {
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) {
    return ''
  }
  return `${value.getFullYear()}-${padDatePart(value.getMonth() + 1)}-${padDatePart(value.getDate())}T${padDatePart(
    value.getHours(),
  )}:${padDatePart(value.getMinutes())}`
}

export function replayLocalDateInputValue(absoluteMs, offsetMinutes = 0) {
  if (!Number.isFinite(Number(absoluteMs))) {
    return ''
  }
  const shifted = replayShiftedDate(absoluteMs, offsetMinutes)
  return `${shifted.getUTCFullYear()}-${padDatePart(shifted.getUTCMonth() + 1)}-${padDatePart(shifted.getUTCDate())}`
}

export function todayAtLocalTimeIso(hour, minute = 0, now = new Date()) {
  return todayAtLocalTime(hour, minute, now).toISOString()
}

export function assignmentIsOpenNow(assignment, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const currentMs = current.getTime()
  const temporaryAccessUntil = Date.parse(String(assignment?.temporary_access_until || ''))
  if (Number.isFinite(temporaryAccessUntil) && temporaryAccessUntil >= currentMs) {
    return true
  }

  const window = assignment?.windows?.[0]
  if (!window) {
    return false
  }

  const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const dayKey = dayKeys[current.getDay()]
  if (window.days && window.days[dayKey] === false) {
    return false
  }
  if (window.end_date) {
    const endDate = new Date(`${window.end_date}T23:59:59.999`)
    if (!Number.isNaN(endDate.getTime()) && currentMs > endDate.getTime()) {
      return false
    }
  }

  const startMinutes = Number(window.start_hour || 0) * 60 + Number(window.start_minute || 0)
  const endMinutes = Number(window.end_hour || 0) * 60 + Number(window.end_minute || 0)
  const currentMinutes = current.getHours() * 60 + current.getMinutes()

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes
  }
  return currentMinutes >= startMinutes || currentMinutes <= endMinutes
}

export function wholeClassExtensionLabel(assignment, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now)
  const currentMs = current.getTime()
  const extensionMs = Date.parse(String(assignment?.temporary_access_until || ''))
  if (!Number.isFinite(extensionMs) || extensionMs <= currentMs) {
    return ''
  }

  const extension = new Date(extensionMs)
  const sameDay =
    extension.getFullYear() === current.getFullYear() &&
    extension.getMonth() === current.getMonth() &&
    extension.getDate() === current.getDate()
  const time = extension.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  if (sameDay) {
    return `Class extended until ${time}`
  }
  return `Class extended until ${extension.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
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
  const parts = [
    selectedAssignment.course || selectedClassroom.name,
    `${activeSessions.length} active student${activeSessions.length === 1 ? '' : 's'}`,
  ]
  const extensionLabel = wholeClassExtensionLabel(selectedAssignment, new Date(now))
  if (extensionLabel) {
    parts.push(extensionLabel)
  }
  return parts.join(' • ')
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
  if (deltaSeconds === 0) return 'just now'
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function normalizeStudentKey(value) {
  return String(value || '').trim().toLowerCase()
}

function compactTimestamp(value) {
  const parsed = parseTimestamp(value)
  if (!parsed) {
    return 'unknown time'
  }
  return new Date(parsed).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function studentRejoinHistoryFor(assignment, studentName) {
  const key = normalizeStudentKey(studentName)
  const history = key ? assignment?.student_rejoin_history?.[key] : null
  if (!history || typeof history !== 'object') {
    return null
  }
  return history
}

export function studentRejoinHistorySummary(assignment, studentName) {
  const history = studentRejoinHistoryFor(assignment, studentName)
  if (!history) {
    return ''
  }
  const closeCount = Math.max(0, Number(history.close_count || 0))
  const events = (Array.isArray(history.events) ? history.events : []).slice(-5)
  if (!closeCount || !events.length) {
    return ''
  }
  const eventText = events
    .map((event) => {
      const label = event?.type === 'locked' ? 'locked' : event?.type === 'closed' ? 'left' : 'opened'
      return `${label} ${compactTimestamp(event?.at)}`
    })
    .join(' · ')
  const noun = closeCount === 1 ? 'quit' : 'quits'
  return `${closeCount} ${noun} this window: ${eventText}`
}

export function formatClockTime(hour = 0, minute = 0) {
  const normalizedHour = Math.max(0, Math.min(23, Number(hour) || 0))
  const normalizedMinute = Math.max(0, Math.min(59, Number(minute) || 0))
  const meridiem = normalizedHour >= 12 ? 'PM' : 'AM'
  const displayHour = normalizedHour % 12 || 12
  return `${displayHour}:${String(normalizedMinute).padStart(2, '0')} ${meridiem}`
}

export function formatWindowSummary(assignment) {
  const window = assignment?.windows?.[0]
  if (!window) {
    return 'No writing window configured.'
  }

  const activeDays = Object.entries(window.days || {})
    .filter(([, enabled]) => Boolean(enabled))
    .map(([day]) => day.slice(0, 3))
  const start = formatClockTime(window.start_hour, window.start_minute)
  const end = formatClockTime(window.end_hour, window.end_minute)
  const daysLabel = activeDays.length ? activeDays.join(', ') : 'No days selected'
  const endDate = window.end_date ? ` until ${window.end_date}` : ''
  return `${daysLabel} • ${start}–${end}${endDate}`
}

export function assignmentWindowForReplayDate(assignment, dateInput, offsetMinutes = 0) {
  const window = assignment?.windows?.[0]
  if (!window) {
    return null
  }
  const dayKey = replayDayKeyForDateInput(dateInput)
  if (!dayKey) {
    return null
  }
  if (window.days && window.days[dayKey] === false) {
    return null
  }
  if (window.end_date && String(dateInput) > String(window.end_date)) {
    return null
  }
  const startMs = replayAbsoluteMsForDateTime(dateInput, window.start_hour, window.start_minute, offsetMinutes)
  const endMs = replayAbsoluteMsForDateTime(dateInput, window.end_hour, window.end_minute, offsetMinutes)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null
  }
  return {
    startMs,
    endMs,
    label: String(window.label || 'Writing window'),
  }
}

export function buildAfterSchoolRanges(
  insertedAtMs,
  assignment,
  {
    dateInput = '',
    offsetMinutes = 0,
    allDates = false,
    fallbackHour = 15,
  } = {},
) {
  const values = Array.isArray(insertedAtMs)
    ? insertedAtMs.map((value) => Number(value)).filter((value) => Number.isFinite(value))
    : []
  const dates = dateInput
    ? [dateInput]
    : allDates
      ? [...new Set(values.map((value) => replayLocalDateInputValue(value, offsetMinutes)).filter(Boolean))]
      : []

  return dates
    .map((date) => {
      const window = assignmentWindowForReplayDate(assignment, date, offsetMinutes)
      const startMs = window?.endMs ?? replayAbsoluteMsForDateTime(date, fallbackHour, 0, offsetMinutes)
      const endMs = replayAbsoluteMsForDateTime(date, 23, 59, offsetMinutes, 59, 999)
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return null
      }
      return { startMs, endMs, date }
    })
    .filter(Boolean)
}
