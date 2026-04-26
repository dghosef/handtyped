import {
  assignmentViewMeta,
  deriveSessionRisk,
  formatWindowSummary,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  timeAgoLabel,
} from './app-ui.js'

const DASHBOARD_REFRESH_MS = 2000

let dashboardState = null
let refreshTimer = null
let refreshInFlight = false
let selectedClassroomId = null
let selectedAssignmentId = null
let currentView = 'classes'
let teacherSession = null
let dashboardCursor = ''
let sessionFilter = 'all'
let sessionSearch = ''

const elements = {
  authPanel: document.getElementById('auth-panel'),
  logoutButton: document.getElementById('logout-button'),
  classroomStage: document.getElementById('classroom-stage'),
  classroomGrid: document.getElementById('classroom-grid'),
  assignmentStage: document.getElementById('assignment-stage'),
  assignmentStageTitle: document.getElementById('assignment-stage-title'),
  assignmentGrid: document.getElementById('assignment-grid'),
  sessionGrid: document.getElementById('session-grid'),
  sessionFilterBar: document.getElementById('session-filter-bar'),
  sessionSearchInput: document.getElementById('session-search-input'),
  assignmentAuditList: document.getElementById('assignment-audit-list'),
  newClassroomButton: document.getElementById('new-classroom-button'),
  deleteClassroomButton: document.getElementById('delete-classroom-button'),
  newAssignmentButton: document.getElementById('new-assignment-button'),
  editAssignmentButton: document.getElementById('edit-assignment-button'),
  classroomForm: document.getElementById('classroom-form'),
  assignmentForm: document.getElementById('assignment-form'),
  assignmentCourseSelect: document.getElementById('assignment-course-select'),
  assignmentIdInput: document.getElementById('assignment-id-input'),
  assignmentModalLabel: document.getElementById('assignment-modal-label'),
  assignmentModalTitle: document.getElementById('assignment-modal-title'),
  assignmentFormSubmit: document.getElementById('assignment-form-submit'),
  assignmentFormCancel: document.getElementById('assignment-form-cancel'),
  assignmentScheduleSummaryText: document.getElementById('assignment-schedule-summary-text'),
  assignmentValidationErrors: document.getElementById('assignment-validation-errors'),
  assignmentValidationWarnings: document.getElementById('assignment-validation-warnings'),
  tempAccess3pmButton: document.getElementById('temp-access-3pm-button'),
  classroomModal: document.getElementById('classroom-modal'),
  assignmentModal: document.getElementById('assignment-modal'),
  modalCloseButtons: document.querySelectorAll('[data-close-modal]'),
  overviewStudents: document.getElementById('overview-students'),
  overviewStudentsMeta: document.getElementById('overview-students-meta'),
  overviewAttention: document.getElementById('overview-attention'),
  overviewAttentionMeta: document.getElementById('overview-attention-meta'),
  overviewUnfocused: document.getElementById('overview-unfocused'),
  overviewUnfocusedMeta: document.getElementById('overview-unfocused-meta'),
  overviewOffline: document.getElementById('overview-offline'),
  overviewOfflineMeta: document.getElementById('overview-offline-meta'),
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/edu/auth/')) {
      window.location.href = '/edu/login'
      throw new Error('Authentication required')
    }
    throw new Error(data?.error || `Request failed: ${response.status}`)
  }

  return data
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function getClassrooms() {
  return dashboardState?.classrooms || []
}

function getAssignments() {
  return dashboardState?.assignments || []
}

function getLiveSessions() {
  return dashboardState?.live_sessions || []
}

function getAssignmentAudits() {
  return dashboardState?.assignment_audits || []
}

function getAssignmentsForClassroom(classroomId = selectedClassroomId) {
  if (!dashboardState || !classroomId) return []
  return getAssignments().filter((assignment) => assignment.classroom_id === classroomId)
}

function getSelectedClassroom() {
  return getClassrooms().find((classroom) => classroom.id === selectedClassroomId) || null
}

function getSelectedAssignment() {
  return getAssignments().find((assignment) => assignment.id === selectedAssignmentId) || null
}

function getSelectedAssignmentAudits() {
  if (!selectedAssignmentId) return []
  return getAssignmentAudits().filter((audit) => audit.assignment_id === selectedAssignmentId)
}

function syncSelectionState() {
  const classrooms = getClassrooms()
  if (!classrooms.some((classroom) => classroom.id === selectedClassroomId)) {
    selectedClassroomId = classrooms[0]?.id || null
  }
  const visibleAssignments = getAssignmentsForClassroom()
  if (!visibleAssignments.some((assignment) => assignment.id === selectedAssignmentId)) {
    selectedAssignmentId = visibleAssignments[0]?.id || null
  }
}

function badge(text, tone = 'default') {
  return `<span class="student-badge student-badge-${tone}">${escapeHtml(text)}</span>`
}

function parseTimeParts(value, fallbackHour, fallbackMinute) {
  const [hour, minute] = String(value || '').split(':').map((part) => Number(part))
  return {
    hour: Number.isFinite(hour) ? hour : fallbackHour,
    minute: Number.isFinite(minute) ? minute : fallbackMinute,
  }
}

function readWindowDays(form) {
  return {
    monday: form.get('day_monday') === 'on',
    tuesday: form.get('day_tuesday') === 'on',
    wednesday: form.get('day_wednesday') === 'on',
    thursday: form.get('day_thursday') === 'on',
    friday: form.get('day_friday') === 'on',
    saturday: form.get('day_saturday') === 'on',
    sunday: form.get('day_sunday') === 'on',
  }
}

function toIsoFromDateTimeLocal(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function setTemporaryAccessToday(hour, minute = 0) {
  const field = elements.assignmentForm?.elements.namedItem('temporary_access_until')
  if (!field) return
  const now = new Date()
  now.setHours(hour, minute, 0, 0)
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  field.value = `${year}-${month}-${day}T${hh}:${mm}`
  updateAssignmentFormGuidance()
}

function openModal(modal) {
  modal.hidden = false
}

function closeModal(modal) {
  modal.hidden = true
}

function populateAssignmentCourseSelect() {
  const classrooms = getClassrooms()
  const selectedId = selectedClassroomId || classrooms[0]?.id || ''
  elements.assignmentCourseSelect.innerHTML = classrooms
    .map(
      (classroom) =>
        `<option value="${escapeHtml(classroom.id)}"${
          classroom.id === selectedId ? ' selected' : ''
        }>${escapeHtml(classroom.name)}</option>`,
    )
    .join('')
}

function renderClassroomGrid() {
  const classrooms = getClassrooms()
  if (!classrooms.length) {
    elements.classroomGrid.innerHTML = `<div class="selection-empty">No classes yet. Create one to get started.</div>`
    return
  }

  elements.classroomGrid.innerHTML = classrooms
    .map((classroom) => {
      const selected = classroom.id === selectedClassroomId
      const assignments = getAssignmentsForClassroom(classroom.id)
      return `
        <button class="selection-card${selected ? ' is-selected' : ''}" type="button" data-classroom-id="${escapeHtml(classroom.id)}">
          <span class="selection-title">${escapeHtml(classroom.name)}</span>
          <span class="selection-meta">${assignments.length} assignment${assignments.length === 1 ? '' : 's'}</span>
          <span class="selection-meta">Join code ${escapeHtml(classroom.join_code || 'No join code')}</span>
        </button>
      `
    })
    .join('')

  elements.classroomGrid.querySelectorAll('[data-classroom-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedClassroomId = button.dataset.classroomId
      selectedAssignmentId = getAssignmentsForClassroom()[0]?.id || null
      renderView()
    })
  })
}

function renderAssignmentStage() {
  const classroom = getSelectedClassroom()
  if (!classroom) {
    elements.assignmentStage.hidden = true
    elements.assignmentGrid.innerHTML = ''
    return
  }

  const assignments = getAssignmentsForClassroom(classroom.id)
  elements.assignmentStage.hidden = false
  elements.assignmentStageTitle.textContent = classroom.name

  if (!assignments.length) {
    elements.assignmentGrid.innerHTML = `<div class="selection-empty">No assignments yet for this class.</div>`
    return
  }

  elements.assignmentGrid.innerHTML = assignments
    .map((assignment) => {
      const selected = assignment.id === selectedAssignmentId
      return `
        <button class="selection-card${selected ? ' is-selected' : ''}" type="button" data-assignment-id="${escapeHtml(assignment.id)}">
          <span class="selection-title">${escapeHtml(assignment.title)}</span>
          <span class="selection-meta">${escapeHtml(assignment.course || classroom.name)}</span>
          <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
        </button>
      `
    })
    .join('')

  elements.assignmentGrid.querySelectorAll('[data-assignment-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAssignmentId = button.dataset.assignmentId
      showAssignmentView()
    })
  })
}

function summarizeViolations(session) {
  const items = (session.violations || []).slice(0, 3)
  if (!items.length) {
    return '<li>No violations recorded.</li>'
  }
  return items
    .map((item) => `<li>${escapeHtml(item.detail || item.kind || 'Policy event')}</li>`)
    .join('')
}

function summarizeUrls(session) {
  const items = (session.url_history || []).slice(-4)
  if (!items.length) {
    return '<li>No recent browser visits.</li>'
  }
  return items.map((item) => `<li>${escapeHtml(item.url || '(unknown url)')}</li>`).join('')
}

function renderMonitoringOverview(matchingSessions) {
  const now = Date.now()
  const activeSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active)
  const attentionSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).needsAttention)
  const unfocusedSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active && !session.focused)
  const offlineSessions = matchingSessions.filter((session) => !deriveSessionRisk(session, now).active)

  elements.overviewStudents.textContent = String(matchingSessions.length)
  elements.overviewStudentsMeta.textContent = `${activeSessions.length} actively reporting`
  elements.overviewAttention.textContent = String(attentionSessions.length)
  elements.overviewAttentionMeta.textContent = attentionSessions.length
    ? 'Students to investigate first'
    : 'No active alerts'
  elements.overviewUnfocused.textContent = String(unfocusedSessions.length)
  elements.overviewUnfocusedMeta.textContent = unfocusedSessions.length
    ? 'Students currently outside the app'
    : 'Everyone is focused'
  elements.overviewOffline.textContent = String(offlineSessions.length)
  elements.overviewOfflineMeta.textContent = offlineSessions.length
    ? 'Students not updating right now'
    : 'All sessions are fresh'
}

function sessionMatchesFilter(session) {
  const now = Date.now()
  const risk = deriveSessionRisk(session, now)
  const nameMatch = !sessionSearch || String(session.student_name || '').toLowerCase().includes(sessionSearch.toLowerCase())
  if (!nameMatch) {
    return false
  }
  switch (sessionFilter) {
    case 'attention':
      return risk.needsAttention
    case 'active':
      return risk.active
    case 'violations':
      return risk.violationCount > 0
    case 'offline':
      return !risk.active
    default:
      return true
  }
}

function renderStudentCards() {
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  const matchingSessions = sessionsForAssignment(
    getLiveSessions(),
    selectedClassroom?.name,
    selectedAssignment?.id,
  )

  const viewTitle = document.getElementById('assignment-view-title')
  const viewMeta = document.getElementById('assignment-view-meta')
  if (selectedAssignment && selectedClassroom) {
    viewTitle.textContent = selectedAssignment.title
    viewMeta.textContent = assignmentViewMeta(selectedAssignment, selectedClassroom, getLiveSessions())
  }

  renderMonitoringOverview(matchingSessions)
  renderAssignmentAudits()

  if (!selectedClassroom || !selectedAssignment) {
    elements.sessionGrid.innerHTML = `<div class="student-empty">Choose an assignment to see student work.</div>`
    return
  }

  const visibleSessions = sortSessionsForDisplay(matchingSessions).filter(sessionMatchesFilter)

  if (!visibleSessions.length) {
    elements.sessionGrid.innerHTML = `<div class="student-empty">No student sessions match the current filter.</div>`
    return
  }

  elements.sessionGrid.innerHTML = visibleSessions
    .map((session) => {
      const now = Date.now()
      const risk = deriveSessionRisk(session, now)
      const replayLink = session.replay_session_id
        ? `<a class="button button-secondary small-button" href="/edu/replay/${escapeHtml(session.replay_session_id)}" target="_blank" rel="noreferrer">Replay</a>`
        : ''
      const badges = [
        badge(sessionStatusLabel(session, now), risk.active ? (session.focused ? 'good' : 'warn') : 'danger'),
        badge(`Risk ${risk.score}`, risk.score >= 45 ? 'danger' : risk.score >= 20 ? 'warn' : 'neutral'),
      ]
      if (risk.violationCount > 0) {
        badges.push(badge(`${risk.violationCount} violation${risk.violationCount === 1 ? '' : 's'}`, 'danger'))
      }
      if (!session.hid_active) {
        badges.push(badge('HID waiting', 'warn'))
      }

      return `
        <article class="student-card student-card-risk-${risk.score >= 45 ? 'high' : risk.score >= 20 ? 'medium' : 'low'}">
          <div class="student-card-header">
            <div>
              <h2>${escapeHtml(session.student_name)}</h2>
              <div class="student-meta">Last activity ${escapeHtml(timeAgoLabel(session.last_activity_at, now))}</div>
            </div>
            <div class="student-badges">${badges.join('')}</div>
          </div>
          <div class="student-card-body">
            <div class="student-section">
              <div class="section-label">Triage</div>
              <div class="student-meta">${escapeHtml(risk.reasons.join(' • ') || 'No active concerns.')}</div>
            </div>
            <div class="student-section">
              <div class="section-label">Current writing</div>
              <div class="student-text">${escapeHtml(session.current_text || '(empty)')}</div>
            </div>
            <div class="student-section">
              <div class="section-label">Recent browser URLs</div>
              <ul class="student-urls">${summarizeUrls(session)}</ul>
            </div>
            <div class="student-section">
              <div class="section-label">Violations</div>
              <ul class="student-violations">${summarizeViolations(session)}</ul>
            </div>
          </div>
          <div class="student-card-footer">
            ${replayLink}
          </div>
        </article>
      `
    })
    .join('')
}

function renderAssignmentAudits() {
  const audits = [...getSelectedAssignmentAudits()].sort((a, b) =>
    String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')),
  )
  if (!audits.length) {
    elements.assignmentAuditList.innerHTML = `<div class="selection-empty">No teacher changes recorded for this assignment yet.</div>`
    return
  }

  elements.assignmentAuditList.innerHTML = audits
    .slice(0, 8)
    .map((audit) => {
      const changes = (audit.changes || [])
        .slice(0, 4)
        .map(
          (change) => `
            <li><strong>${escapeHtml(change.label)}:</strong> ${escapeHtml(
              change.after == null ? 'cleared' : typeof change.after === 'object' ? JSON.stringify(change.after) : String(change.after),
            )}</li>
          `,
        )
        .join('')
      return `
        <article class="audit-entry">
          <div class="audit-entry-header">
            <div>
              <div class="section-label">${escapeHtml(audit.action || 'updated')}</div>
              <h4>${escapeHtml(audit.summary || 'Assignment updated')}</h4>
            </div>
            <div class="student-meta">${escapeHtml(timeAgoLabel(audit.created_at || audit.updated_at))}</div>
          </div>
          <div class="student-meta">${escapeHtml(audit.actor_name || audit.actor_email || 'Teacher')}</div>
          ${changes ? `<ul class="audit-changes">${changes}</ul>` : ''}
        </article>
      `
    })
    .join('')
}

function renderDashboard(data) {
  dashboardState = data
  dashboardCursor = String(data?.updated_at || dashboardCursor || '')
  syncSelectionState()
  populateAssignmentCourseSelect()
  renderView()
}

function mergeById(previous, incoming) {
  const map = new Map((previous || []).map((item) => [item.id, item]))
  for (const item of incoming || []) {
    map.set(item.id, item)
  }
  return [...map.values()]
}

function applyDashboardDelta(delta) {
  if (!dashboardState) {
    renderDashboard(delta)
    return
  }
  dashboardState = {
    ...dashboardState,
    updated_at: delta.updated_at || dashboardState.updated_at,
    summary: delta.summary || dashboardState.summary,
    classrooms: Array.isArray(delta.classrooms) ? delta.classrooms : dashboardState.classrooms,
    assignments: Array.isArray(delta.assignments) ? delta.assignments : dashboardState.assignments,
    live_sessions: mergeById(dashboardState.live_sessions, delta.live_sessions),
    assignment_audits: mergeById(dashboardState.assignment_audits, delta.assignment_audits),
  }
  if (Array.isArray(delta.replays) && dashboardState.summary) {
    dashboardState.summary.replays_available = Math.max(
      Number(dashboardState.summary.replays_available || 0),
      Number(delta.summary?.replays_available || dashboardState.summary.replays_available || 0),
    )
  }
  dashboardCursor = String(delta.updated_at || dashboardCursor || '')
  syncSelectionState()
  renderView()
}

function renderView() {
  const classesView = document.getElementById('classes-view')
  const assignmentView = document.getElementById('assignment-view')
  if (elements.deleteClassroomButton) {
    elements.deleteClassroomButton.disabled = !getSelectedClassroom()
  }

  if (currentView === 'assignment' && selectedAssignmentId) {
    classesView.hidden = true
    assignmentView.hidden = false
    renderStudentCards()
  } else {
    classesView.hidden = false
    assignmentView.hidden = true
    renderClassroomGrid()
    renderAssignmentStage()
  }
}

function showAssignmentView() {
  currentView = 'assignment'
  renderView()
}

function showClassesView() {
  currentView = 'classes'
  selectedAssignmentId = null
  renderView()
}

async function refreshDashboard() {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    if (!dashboardState) {
      renderDashboard(await request('/api/edu/dashboard'))
      return
    }
    const delta = await request(`/api/edu/dashboard/updates?since=${encodeURIComponent(dashboardCursor || '')}`)
    applyDashboardDelta(delta)
  } finally {
    refreshInFlight = false
  }
}

function startDashboardRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer)
  }
  refreshTimer = window.setInterval(() => {
    if (!document.hidden) {
      refreshDashboard().catch(() => {})
    }
  }, DASHBOARD_REFRESH_MS)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshDashboard().catch(() => {})
    }
  })
}

function dayLabel(days) {
  const labels = Object.entries(days || {})
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name.slice(0, 3))
  return labels.length ? labels.join(', ') : 'No days selected'
}

function renderValidationList(element, items) {
  element.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')
  element.hidden = !items.length
}

function validateAssignmentDraft() {
  const form = new FormData(elements.assignmentForm)
  const errors = []
  const warnings = []
  const days = readWindowDays(form)
  const hasDay = Object.values(days).some(Boolean)
  const start = parseTimeParts(form.get('window_start_time'), 10, 0)
  const end = parseTimeParts(form.get('window_end_time'), 11, 0)
  const startMinutes = start.hour * 60 + start.minute
  const endMinutes = end.hour * 60 + end.minute
  const browserEnabled = form.get('browser_enabled') === 'on'
  const homeUrl = String(form.get('browser_home_url') || '').trim()
  const domains = String(form.get('browser_allowed_domains') || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  if (!hasDay) {
    errors.push('Select at least one day of the week.')
  }
  if (endMinutes <= startMinutes) {
    errors.push('End time must be after start time.')
  }
  if (browserEnabled && !homeUrl) {
    errors.push('Study browser is enabled, so a home URL is required.')
  }
  if (browserEnabled && !domains.length) {
    warnings.push('Study browser is enabled without any allowlisted domains.')
  }
  if (form.get('require_lockdown') === 'on' && form.get('browser_enabled') !== 'on') {
    warnings.push('Lockdown is on and the study browser is disabled. Students will only have the writing workspace.')
  }
  if (form.get('temporary_access_until')) {
    const temporaryAccess = new Date(String(form.get('temporary_access_until')))
    if (!Number.isNaN(temporaryAccess.getTime()) && temporaryAccess.getTime() < Date.now()) {
      warnings.push('Temporary access time is already in the past.')
    }
  }

  const summary = `${dayLabel(days)} • ${String(form.get('window_start_time') || '')}–${String(
    form.get('window_end_time') || '',
  )}${form.get('window_end_date') ? ` until ${String(form.get('window_end_date'))}` : ''}`

  return { errors, warnings, summary }
}

function updateAssignmentFormGuidance() {
  const { errors, warnings, summary } = validateAssignmentDraft()
  elements.assignmentScheduleSummaryText.textContent = summary
  renderValidationList(elements.assignmentValidationErrors, errors)
  renderValidationList(elements.assignmentValidationWarnings, warnings)
  elements.assignmentFormSubmit.disabled = errors.length > 0
}

function wireModalButtons() {
  elements.newClassroomButton.addEventListener('click', () => openModal(elements.classroomModal))

  elements.deleteClassroomButton?.addEventListener('click', async () => {
    const classroom = getSelectedClassroom()
    if (!classroom) {
      window.alert('Select a class first.')
      return
    }
    if (!window.confirm(`Delete ${classroom.name}? This will also remove its assignments.`)) {
      return
    }
    try {
      await request(`/api/edu/classrooms/${classroom.id}`, { method: 'DELETE' })
      selectedClassroomId = null
      selectedAssignmentId = null
      currentView = 'classes'
      dashboardState = null
      await refreshDashboard()
    } catch (error) {
      window.alert(`Could not delete class: ${error.message}`)
    }
  })

  elements.newAssignmentButton.addEventListener('click', () => {
    if (!getSelectedClassroom()) {
      window.alert('Create or select a class first.')
      return
    }
    populateAssignmentCourseSelect()
    resetAssignmentModal()
    openModal(elements.assignmentModal)
  })

  elements.editAssignmentButton?.addEventListener('click', () => {
    const assignment = getSelectedAssignment()
    if (!assignment) {
      window.alert('Select an assignment first.')
      return
    }
    populateAssignmentCourseSelect()
    populateAssignmentModalForEdit(assignment)
    openModal(elements.assignmentModal)
  })

  elements.modalCloseButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const modalId = button.dataset.closeModal
      if (modalId === 'classroom-modal') closeModal(elements.classroomModal)
      if (modalId === 'assignment-modal') closeModal(elements.assignmentModal)
    })
  })

  ;[elements.classroomModal, elements.assignmentModal].forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal)
    })
  })

  document.getElementById('back-to-assignments-button')?.addEventListener('click', () => showClassesView())
  elements.tempAccess3pmButton?.addEventListener('click', () => setTemporaryAccessToday(15, 0))
  elements.assignmentFormCancel?.addEventListener('click', () => {
    closeModal(elements.assignmentModal)
    resetAssignmentModal()
  })
}

function resetAssignmentModal() {
  elements.assignmentIdInput.value = ''
  elements.assignmentModalLabel.textContent = 'Create assignment'
  elements.assignmentModalTitle.textContent = 'New assignment'
  elements.assignmentFormSubmit.textContent = 'Create assignment'
  elements.assignmentFormCancel.hidden = true
  elements.assignmentForm.reset()
  elements.assignmentCourseSelect.disabled = false
  populateAssignmentCourseSelect()
  updateAssignmentFormGuidance()
}

function populateAssignmentModalForEdit(assignment) {
  elements.assignmentIdInput.value = assignment.id
  elements.assignmentModalLabel.textContent = 'Edit assignment'
  elements.assignmentModalTitle.textContent = assignment.title
  elements.assignmentFormSubmit.textContent = 'Save changes'
  elements.assignmentFormCancel.hidden = false

  const form = elements.assignmentForm
  form.title.value = assignment.title || ''
  form.prompt.value = assignment.prompt || ''
  populateAssignmentCourseSelect()
  form.course.value = assignment.classroom_id || selectedClassroomId || ''
  elements.assignmentCourseSelect.disabled = true
  form.temporary_access_until.value = assignment.temporary_access_until || ''

  if (assignment.windows?.[0]) {
    const win = assignment.windows[0]
    form.window_start_time.value = `${String(win.start_hour).padStart(2, '0')}:${String(win.start_minute).padStart(2, '0')}`
    form.window_end_time.value = `${String(win.end_hour).padStart(2, '0')}:${String(win.end_minute).padStart(2, '0')}`
    form.window_end_date.value = win.end_date || ''
    form.day_monday.checked = win.days?.monday ?? true
    form.day_tuesday.checked = win.days?.tuesday ?? true
    form.day_wednesday.checked = win.days?.wednesday ?? true
    form.day_thursday.checked = win.days?.thursday ?? true
    form.day_friday.checked = win.days?.friday ?? true
    form.day_saturday.checked = win.days?.saturday ?? false
    form.day_sunday.checked = win.days?.sunday ?? false
  }

  if (assignment.policy) {
    form.copy_paste_allowed.checked = assignment.policy.copy_paste_allowed ?? false
    form.printing_allowed.checked = assignment.policy.printing_allowed ?? false
    form.require_lockdown.checked = assignment.policy.require_lockdown ?? false
    form.require_fullscreen.checked = assignment.policy.require_fullscreen ?? false
  }

  if (assignment.browser_policy) {
    form.browser_enabled.checked = assignment.browser_policy.browser_enabled ?? false
    form.browser_home_url.value = assignment.browser_policy.home_url || ''
    form.browser_allowed_domains.value = (assignment.browser_policy.allowed_domains || []).join('\n')
  }
  updateAssignmentFormGuidance()
}

function wireForms() {
  elements.classroomForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    try {
      const form = new FormData(formEl)
      await request('/api/edu/classrooms', {
        method: 'POST',
        body: JSON.stringify({
          name: form.get('name'),
          teacher_name: teacherSession?.teacher_name || 'Teacher',
          join_code: form.get('join_code') || undefined,
        }),
      })
      formEl.reset()
      closeModal(elements.classroomModal)
      dashboardState = null
      await refreshDashboard()
    } catch (error) {
      window.alert(`Could not create class: ${error.message}`)
    }
  })

  elements.assignmentForm.addEventListener('input', updateAssignmentFormGuidance)
  elements.assignmentForm.addEventListener('change', updateAssignmentFormGuidance)

  elements.assignmentForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
    const validation = validateAssignmentDraft()
    if (validation.errors.length) {
      updateAssignmentFormGuidance()
      return
    }

    try {
      const form = new FormData(formEl)
      const assignmentId = form.get('assignment_id')
      const isEditing = !!assignmentId
      const classroomId = form.get('course')
      const activeClassroom = getClassrooms().find((classroom) => classroom.id === classroomId)
      const startTime = parseTimeParts(form.get('window_start_time'), 10, 0)
      const endTime = parseTimeParts(form.get('window_end_time'), 11, 0)

      if (!isEditing && !activeClassroom) {
        window.alert('Choose a class first before creating an assignment.')
        return
      }

      const payload = {
        title: form.get('title'),
        course: activeClassroom ? activeClassroom.name : getSelectedClassroom()?.name || '',
        classroom_id: isEditing ? undefined : activeClassroom?.id,
        classroom_name: isEditing ? undefined : activeClassroom?.name,
        prompt: form.get('prompt'),
        windows: [
          {
            label: 'Teacher writing window',
            days: readWindowDays(form),
            end_date: form.get('window_end_date') || null,
            start_hour: startTime.hour,
            start_minute: startTime.minute,
            end_hour: endTime.hour,
            end_minute: endTime.minute,
          },
        ],
        temporary_access_until: toIsoFromDateTimeLocal(form.get('temporary_access_until')),
        policy: {
          copy_paste_allowed: form.get('copy_paste_allowed') === 'on',
          printing_allowed: form.get('printing_allowed') === 'on',
          require_lockdown: form.get('require_lockdown') === 'on',
          require_fullscreen: form.get('require_fullscreen') === 'on',
        },
        browser_policy: {
          browser_enabled: form.get('browser_enabled') === 'on',
          home_url: form.get('browser_home_url') || '',
          allowed_domains: String(form.get('browser_allowed_domains') || '')
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
      }

      if (isEditing) {
        await request(`/api/edu/assignments/${assignmentId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        })
      } else {
        await request('/api/edu/assignments', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
      }

      formEl.reset()
      resetAssignmentModal()
      closeModal(elements.assignmentModal)
      dashboardState = null
      await refreshDashboard()
      renderView()
    } catch (error) {
      window.alert(`Could not save assignment: ${error.message}`)
    }
  })
}

function wireMonitoringControls() {
  elements.sessionFilterBar?.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      sessionFilter = button.dataset.filter || 'all'
      elements.sessionFilterBar.querySelectorAll('[data-filter]').forEach((node) => {
        node.classList.toggle('is-selected', node === button)
      })
      renderStudentCards()
    })
  })

  elements.sessionSearchInput?.addEventListener('input', () => {
    sessionSearch = elements.sessionSearchInput.value.trim()
    renderStudentCards()
  })
}

async function loadApp() {
  teacherSession = await request('/api/edu/auth/session')
  if (!teacherSession.authenticated) {
    window.location.href = '/edu/login'
    return
  }

  elements.logoutButton.hidden = false
  elements.logoutButton.addEventListener('click', async () => {
    await request('/api/edu/auth/logout', { method: 'POST' })
    window.location.href = '/edu/login'
  })

  elements.authPanel.innerHTML = `
    <div class="section-label">Signed in</div>
    <h2>${escapeHtml(teacherSession.teacher_name)}</h2>
    <p class="subhead">${escapeHtml(teacherSession.teacher_email || '')}</p>
  `

  wireModalButtons()
  wireForms()
  wireMonitoringControls()
  await refreshDashboard()
  startDashboardRefresh()
}

loadApp().catch((error) => {
  document.body.innerHTML = `<div style="padding:32px;font-family:'Open Sans', Arial, Helvetica, sans-serif">Could not load Handtyped EDU: ${escapeHtml(error.message)}</div>`
})
