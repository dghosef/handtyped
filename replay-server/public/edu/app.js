const DASHBOARD_REFRESH_MS = 3000
const LIVE_SESSION_STALE_MS = 15000

let dashboardState = null
let refreshTimer = null
let refreshInFlight = false
let selectedClassroomId = null
let selectedAssignmentId = null
let currentView = 'classes' // 'classes' or 'assignment'
let teacherSession = null

const elements = {
  authPanel: document.getElementById('auth-panel'),
  logoutButton: document.getElementById('logout-button'),
  classroomStage: document.getElementById('classroom-stage'),
  classroomGrid: document.getElementById('classroom-grid'),
  assignmentStage: document.getElementById('assignment-stage'),
  assignmentStageTitle: document.getElementById('assignment-stage-title'),
  assignmentGrid: document.getElementById('assignment-grid'),
  sessionGrid: document.getElementById('session-grid'),
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
  tempAccess3pmButton: document.getElementById('temp-access-3pm-button'),
  classroomModal: document.getElementById('classroom-modal'),
  assignmentModal: document.getElementById('assignment-modal'),
  modalCloseButtons: document.querySelectorAll('[data-close-modal]'),
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

function getAssignmentsForClassroom(classroomId = selectedClassroomId) {
  if (!dashboardState || !classroomId) {
    return []
  }
  return dashboardState.assignments.filter((assignment) => assignment.classroom_id === classroomId)
}

function getSelectedClassroom() {
  return getClassrooms().find((classroom) => classroom.id === selectedClassroomId) || null
}

function getSelectedAssignment() {
  return (
    dashboardState?.assignments.find((assignment) => assignment.id === selectedAssignmentId) || null
  )
}

function lastItem(items) {
  return items.length ? items[items.length - 1] : null
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

function badge(text) {
  return `<span class="student-badge">${escapeHtml(text)}</span>`
}

function parseTimestamp(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isNaN(parsed) ? null : parsed
}

function isSessionActive(session) {
  if (!session?.schedule_open) {
    return false
  }
  const lastActivityAt = parseTimestamp(session.last_activity_at || session.updated_at)
  if (!lastActivityAt) {
    return false
  }
  return Date.now() - lastActivityAt <= LIVE_SESSION_STALE_MS
}

function sessionStatusLabel(session) {
  if (!isSessionActive(session)) {
    return 'Offline'
  }
  return session.focused ? 'Focused' : 'Unfocused'
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
  if (!raw) {
    return null
  }
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function setTemporaryAccessToday(hour, minute = 0) {
  const field = elements.assignmentForm?.elements.namedItem('temporary_access_until')
  if (!field) {
    return
  }
  const now = new Date()
  now.setHours(hour, minute, 0, 0)
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  field.value = `${year}-${month}-${day}T${hh}:${mm}`
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
    elements.classroomGrid.innerHTML = `
      <div class="selection-empty">No classes yet. Create one to get started.</div>
    `
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
          <span class="selection-meta">${escapeHtml(classroom.join_code || 'No join code')}</span>
        </button>
      `
    })
    .join('')

  elements.classroomGrid.querySelectorAll('[data-classroom-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedClassroomId = button.dataset.classroomId
      selectedAssignmentId = getAssignmentsForClassroom()[0]?.id || null
      renderDashboard(dashboardState)
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
    elements.assignmentGrid.innerHTML = `
      <div class="selection-empty">No assignments yet for this class.</div>
    `
    return
  }

  elements.assignmentGrid.innerHTML = assignments
    .map((assignment) => {
      const selected = assignment.id === selectedAssignmentId
      return `
        <button class="selection-card${selected ? ' is-selected' : ''}" type="button" data-assignment-id="${escapeHtml(assignment.id)}">
          <span class="selection-title">${escapeHtml(assignment.title)}</span>
          <span class="selection-meta">${escapeHtml(assignment.course || classroom.name)}</span>
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

function renderStudentCards() {
  const sessions = dashboardState?.live_sessions || []
  const selectedClassroom = getSelectedClassroom()
  const selectedAssignment = getSelectedAssignment()
  const matchingSessions = sessions.filter(
    (session) =>
      session.assignment_id === selectedAssignment?.id &&
      session.classroom === selectedClassroom?.name,
  )
  const activeSessions = matchingSessions.filter((session) => isSessionActive(session))

  // Update the assignment view header
  const viewTitle = document.getElementById('assignment-view-title')
  const viewMeta = document.getElementById('assignment-view-meta')
  if (selectedAssignment && selectedClassroom) {
    viewTitle.textContent = selectedAssignment.title
    viewMeta.textContent = `${selectedAssignment.course || selectedClassroom.name} • ${activeSessions.length} active student${activeSessions.length === 1 ? '' : 's'}`
  }

  if (!selectedClassroom) {
    elements.sessionGrid.innerHTML = ''
    return
  }

  if (!selectedAssignment) {
    elements.sessionGrid.innerHTML = `
      <div class="student-empty">Choose an assignment to see student work.</div>
    `
    return
  }

  const visibleSessions = matchingSessions.sort((a, b) => {
    const activeDelta = Number(isSessionActive(b)) - Number(isSessionActive(a))
    if (activeDelta !== 0) {
      return activeDelta
    }
    return String(b.last_activity_at || b.updated_at || '').localeCompare(String(a.last_activity_at || a.updated_at || ''))
  })

  if (!visibleSessions.length) {
    elements.sessionGrid.innerHTML = `
      <div class="student-empty">
        No student sessions for this assignment yet.
      </div>
    `
    return
  }

  elements.sessionGrid.innerHTML = visibleSessions
    .map((session) => {
      const replayLink = session.replay_session_id
        ? `<a class="button button-secondary small-button" href="/edu/replay/${escapeHtml(
            session.replay_session_id,
          )}" target="_blank" rel="noreferrer">Replay</a>`
        : ''

      const urlHistory = session.url_history?.length
        ? session.url_history
            .slice(-5)
            .map((v) => `<li>${escapeHtml(v.url)}</li>`)
            .join('')
        : 'None'

      return `
        <article class="student-card">
          <div class="student-card-header">
            <h2>${escapeHtml(session.student_name)}</h2>
            <div class="student-badges">
              ${badge(sessionStatusLabel(session))}
            </div>
          </div>
          <div class="student-card-body">
            <div class="student-section">
              <div class="section-label">Document</div>
              <div class="student-text">${escapeHtml(session.current_text || '(empty)')}</div>
            </div>
            <div class="student-section">
              <div class="section-label">Browser URLs</div>
              <ul class="student-urls">${urlHistory}</ul>
            </div>
            <div class="student-meta">Last activity: ${escapeHtml(session.last_activity_at || 'Unknown')}</div>
          </div>
          <div class="student-card-footer">
            ${replayLink}
          </div>
        </article>
      `
    })
    .join('')
}

function renderDashboard(data) {
  dashboardState = data
  syncSelectionState()
  populateAssignmentCourseSelect()
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
  if (refreshInFlight) {
    return
  }
  refreshInFlight = true
  try {
    renderDashboard(await request('/api/edu/dashboard'))
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

function wireModalButtons() {
  elements.newClassroomButton.addEventListener('click', () => {
    openModal(elements.classroomModal)
  })

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
      if (selectedClassroomId === classroom.id) {
        selectedClassroomId = null
        selectedAssignmentId = null
        currentView = 'classes'
      }
      await refreshDashboard()
      renderDashboard(dashboardState)
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
      if (modalId === 'classroom-modal') {
        closeModal(elements.classroomModal)
      }
      if (modalId === 'assignment-modal') {
        closeModal(elements.assignmentModal)
      }
    })
  })

  ;[elements.classroomModal, elements.assignmentModal].forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        closeModal(modal)
      }
    })
  })

  document.getElementById('back-to-assignments-button')?.addEventListener('click', () => {
    showClassesView()
  })

  elements.tempAccess3pmButton?.addEventListener('click', () => {
    setTemporaryAccessToday(15, 0)
  })

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
    form.require_lockdown.checked = assignment.policy.require_lockdown ?? false
    form.require_fullscreen.checked = assignment.policy.require_fullscreen ?? false
  }

  if (assignment.browser_policy) {
    form.browser_enabled.checked = assignment.browser_policy.browser_enabled ?? false
    form.browser_home_url.value = assignment.browser_policy.home_url || ''
    form.browser_allowed_domains.value = (assignment.browser_policy.allowed_domains || []).join('\n')
  }
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
      await refreshDashboard()
      selectedClassroomId = lastItem(getClassrooms())?.id || getClassrooms()[0]?.id || null
      selectedAssignmentId = getAssignmentsForClassroom()[0]?.id || null
      renderDashboard(dashboardState)
    } catch (error) {
      window.alert(`Could not create class: ${error.message}`)
    }
  })

  elements.assignmentForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const formEl = event.currentTarget
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
          require_lockdown: form.get('require_lockdown') === 'on',
          require_fullscreen: form.get('require_fullscreen') === 'on',
        },
        browser_policy: {
          browser_enabled: form.get('browser_enabled') === 'on',
          home_url: form.get('browser_home_url') || '',
          allowed_domains: (form.get('browser_allowed_domains') || '')
            .split('\n')
            .map(d => d.trim())
            .filter(d => d),
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
      await refreshDashboard()
      renderDashboard(dashboardState)
    } catch (error) {
      window.alert(`Could not save assignment: ${error.message}`)
    }
  })
}

async function loadApp() {
  teacherSession = await request('/api/edu/auth/session')
  if (!teacherSession.authenticated) {
    elements.authPanel.innerHTML = `
      <div class="section-label">Authentication required</div>
      <h2>Sign in to open the teacher workspace</h2>
      <p class="subhead">Teacher workflows live on the web at edu.handtyped.app.</p>
      <div class="topbar-actions"><a class="button" href="/login">Go to sign in</a></div>
    `
    return
  }

  elements.logoutButton.hidden = false
  elements.logoutButton.addEventListener('click', async () => {
    await request('/api/edu/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  })

  elements.authPanel.innerHTML = `
    <div class="section-label">Signed in</div>
    <h2>${escapeHtml(teacherSession.teacher_name)}</h2>
    <p class="subhead">${escapeHtml(teacherSession.teacher_email || '')}</p>
  `

  wireModalButtons()
  wireForms()
  await refreshDashboard()
  startDashboardRefresh()
}

loadApp().catch((error) => {
  document.body.innerHTML = `<div style="padding:32px;font-family:'Open Sans', Arial, Helvetica, sans-serif">Could not load Handtyped EDU: ${escapeHtml(
    error.message,
  )}</div>`
})
