import {
  aggregateRecentEditActivity,
  assignmentViewMeta,
  deriveSessionRisk,
  formatWindowSummary,
  localDateTimeInputValue,
  recentEditActivity,
  reconcileTeacherNavigation,
  sessionStatusLabel,
  sessionsForAssignment,
  sortSessionsForDisplay,
  timeAgoLabel,
  todayAtLocalTime,
  todayAtLocalTimeIso,
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
let assignmentStudentOverrideDrafts = []
let selectedReviewSessionId = null
let reviewState = null
let reviewSaveTimer = null
let reviewSaveInFlight = false
let reviewSavePromise = null
let selectedAnnotationId = null

const elements = {
  authPanel: document.getElementById('auth-panel'),
  logoutButton: document.getElementById('logout-button'),
  classesView: document.getElementById('classes-view'),
  assignmentsView: document.getElementById('assignments-view'),
  assignmentView: document.getElementById('assignment-view'),
  classroomStage: document.getElementById('classroom-stage'),
  classroomGrid: document.getElementById('classroom-grid'),
  assignmentStage: document.getElementById('assignment-stage'),
  assignmentStageTitle: document.getElementById('assignment-stage-title'),
  assignmentStageMeta: document.getElementById('assignment-stage-meta'),
  assignmentGrid: document.getElementById('assignment-grid'),
  sessionGrid: document.getElementById('session-grid'),
  sessionFilterBar: document.getElementById('session-filter-bar'),
  sessionSearchInput: document.getElementById('session-search-input'),
  newClassroomButton: document.getElementById('new-classroom-button'),
  deleteClassroomButton: document.getElementById('delete-classroom-button'),
  newAssignmentButton: document.getElementById('new-assignment-button'),
  editAssignmentButton: document.getElementById('edit-assignment-button'),
  deleteAssignmentButton: document.getElementById('delete-assignment-button'),
  quickExtendButton: document.getElementById('quick-extend-button'),
  quickExtendTime: document.getElementById('quick-extend-time'),
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
  assignmentAssignedOptions: document.getElementById('assignment-assigned-options'),
  assignmentAssignedExtra: document.getElementById('assignment-assigned-extra'),
  assignmentStudentOverrideList: document.getElementById('assignment-student-override-list'),
  assignmentStudentOverrideSuggestions: document.getElementById('assignment-student-override-suggestions'),
  assignmentAddStudentOverride: document.getElementById('assignment-add-student-override'),
  assignmentLinkedOptions: document.getElementById('assignment-linked-options'),
  assignmentRubricList: document.getElementById('assignment-rubric-list'),
  assignmentAddRubric: document.getElementById('assignment-add-rubric'),
  tempAccessTime: document.getElementById('temp-access-time'),
  tempAccessTimeButton: document.getElementById('temp-access-time-button'),
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
  overviewEdits: document.getElementById('overview-edits'),
  overviewEditsMeta: document.getElementById('overview-edits-meta'),
  assignmentAuditList: document.getElementById('assignment-audit-list'),
  reviewWorkspace: document.getElementById('review-workspace'),
  reviewWorkspaceEmpty: document.getElementById('review-workspace-empty'),
  reviewWorkspaceContent: document.getElementById('review-workspace-content'),
  reviewWorkspaceTitle: document.getElementById('review-workspace-title'),
  reviewWorkspaceMeta: document.getElementById('review-workspace-meta'),
  reviewSyncStatus: document.getElementById('review-sync-status'),
  reviewGradeLabel: document.getElementById('review-grade-label'),
  reviewGradeScore: document.getElementById('review-grade-score'),
  reviewRubricTotal: document.getElementById('review-rubric-total'),
  reviewRubricList: document.getElementById('review-rubric-list'),
  reviewTeacherComment: document.getElementById('review-teacher-comment'),
  reviewSuggestedRevisions: document.getElementById('review-suggested-revisions'),
  reviewReturned: document.getElementById('review-returned'),
  reviewDraftMeta: document.getElementById('review-draft-meta'),
  reviewDraftSurface: document.getElementById('review-draft-surface'),
  reviewSelectionCount: document.getElementById('review-selection-count'),
  reviewSelectionPanel: document.getElementById('review-selection-panel'),
  reviewSelectionQuote: document.getElementById('review-selection-quote'),
  reviewCommentMode: document.getElementById('review-comment-mode'),
  reviewSuggestMode: document.getElementById('review-suggest-mode'),
  reviewComposer: document.getElementById('review-composer'),
  reviewComposerLabel: document.getElementById('review-composer-label'),
  reviewReplacementField: document.getElementById('review-replacement-field'),
  reviewComposerReplacement: document.getElementById('review-composer-replacement'),
  reviewComposerNote: document.getElementById('review-composer-note'),
  reviewAddAnnotation: document.getElementById('review-add-annotation'),
  reviewCancelAnnotation: document.getElementById('review-cancel-annotation'),
  reviewAnnotationMeta: document.getElementById('review-annotation-meta'),
  reviewAnnotationList: document.getElementById('review-annotation-list'),
}

const STUDENT_OVERRIDE_BOOLEAN_FIELDS = [
  ['allow_dictation', 'Allow dictation'],
  ['copy_paste_allowed', 'Allow copy/paste'],
  ['printing_allowed', 'Allow printing'],
  ['export_allowed', 'Allow export'],
  ['images_allowed', 'Allow images'],
  ['citations_required', 'Require citations'],
  ['require_lockdown', 'Require lockdown'],
  ['require_fullscreen', 'Require fullscreen'],
  ['browser_enabled', 'Enable study browser'],
]

const STUDENT_OVERRIDE_FONT_OPTIONS = [
  ['arial', 'Arial'],
  ['serif', 'Serif'],
  ['sans', 'Sans'],
  ['mono', 'Mono'],
]

const STUDENT_OVERRIDE_FONT_SIZE_OPTIONS = ['16', '18', '20', '22', '24', '28', '32']

const STUDENT_OVERRIDE_LINE_HEIGHT_OPTIONS = [
  ['single', 'Single'],
  ['relaxed', '1.15'],
  ['one-half', '1.5'],
  ['double', 'Double'],
]

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

function currentReviewSession() {
  return getLiveSessions().find((session) => session.id === selectedReviewSessionId) || null
}

function normalizedInlineAnnotation(annotation = {}) {
  const start = Math.max(0, Number(annotation.start ?? 0) || 0)
  const end = Math.max(start, Number(annotation.end ?? start) || start)
  return {
    id: annotation.id || `annotation_${Math.random().toString(36).slice(2, 10)}`,
    type: annotation.type === 'suggestion' ? 'suggestion' : 'comment',
    start,
    end,
    quote: String(annotation.quote || ''),
    note: String(annotation.note || ''),
    replacement: annotation.type === 'suggestion' ? String(annotation.replacement || '') : '',
    created_at: annotation.created_at || new Date().toISOString(),
    updated_at: annotation.updated_at || annotation.created_at || new Date().toISOString(),
  }
}

function normalizedSessionGrading(session = {}) {
  const grading = session?.grading && typeof session.grading === 'object' ? session.grading : {}
  const inlineAnnotations = Array.isArray(grading.inline_annotations)
    ? grading.inline_annotations.map(normalizedInlineAnnotation).sort((a, b) => a.start - b.start || a.end - b.end)
    : []
  return {
    rubric_scores:
      grading.rubric_scores && typeof grading.rubric_scores === 'object' ? { ...grading.rubric_scores } : {},
    teacher_comment: String(grading.teacher_comment || ''),
    suggested_revisions: String(grading.suggested_revisions || ''),
    returned_for_revision: Boolean(grading.returned_for_revision),
    grade_label: String(grading.grade_label || ''),
    grade_score:
      grading.grade_score === '' || grading.grade_score == null || Number.isNaN(Number(grading.grade_score))
        ? ''
        : String(grading.grade_score),
    inline_annotations: inlineAnnotations,
    updated_at: grading.updated_at || null,
    actor_name: grading.actor_name || '',
    actor_email: grading.actor_email || '',
  }
}

function reviewSummaryForSession(session, assignment) {
  const grading = normalizedSessionGrading(session)
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  const earnedPoints = rubric.reduce((sum, criterion) => sum + Number(grading.rubric_scores[criterion.id] || 0), 0)
  const totalPoints = rubric.reduce((sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)), 0)
  return {
    grading,
    earnedPoints,
    totalPoints,
    annotationCount: grading.inline_annotations.length,
  }
}

function createReviewStateFromSession(session) {
  const grading = normalizedSessionGrading(session)
  return {
    sessionId: session.id,
    gradeLabel: grading.grade_label,
    gradeScore: grading.grade_score,
    rubricScores: { ...grading.rubric_scores },
    teacherComment: grading.teacher_comment,
    suggestedRevisions: grading.suggested_revisions,
    returnedForRevision: grading.returned_for_revision,
    inlineAnnotations: grading.inline_annotations,
    updatedAt: grading.updated_at,
    updatedBy: grading.actor_name || grading.actor_email || '',
    saveState: grading.updated_at ? 'saved' : 'idle',
    dirty: false,
    selection: null,
    composerMode: '',
    composerNote: '',
    composerReplacement: '',
  }
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
  const nextSelection = reconcileTeacherNavigation({
    classrooms: getClassrooms(),
    assignments: getAssignments(),
    selectedClassroomId,
    selectedAssignmentId,
    currentView,
  })
  selectedClassroomId = nextSelection.selectedClassroomId
  selectedAssignmentId = nextSelection.selectedAssignmentId
  currentView = nextSelection.currentView
}

function badge(text, tone = 'default') {
  return `<span class="student-badge student-badge-${tone}">${escapeHtml(text)}</span>`
}

function normalizeStudentOverrideKey(studentName) {
  return String(studentName || '').trim().toLowerCase()
}

function createStudentOverrideDraft(input = {}) {
  return {
    id: input.id || `student_override_${Math.random().toString(36).slice(2, 10)}`,
    student_name: String(input.student_name || '').trim(),
    temporary_access_enabled: Boolean(input.temporary_access_enabled),
    temporary_access_until: String(input.temporary_access_until || ''),
    policy: {
      allow_dictation: input.policy?.allow_dictation || 'default',
      copy_paste_allowed: input.policy?.copy_paste_allowed || 'default',
      printing_allowed: input.policy?.printing_allowed || 'default',
      export_allowed: input.policy?.export_allowed || 'default',
      images_allowed: input.policy?.images_allowed || 'default',
      citations_required: input.policy?.citations_required || 'default',
      require_lockdown: input.policy?.require_lockdown || 'default',
      require_fullscreen: input.policy?.require_fullscreen || 'default',
      browser_enabled: input.policy?.browser_enabled || 'default',
    },
    editor_policy: {
      font_family: input.editor_policy?.font_family || 'default',
      font_size: input.editor_policy?.font_size || 'default',
      line_height: input.editor_policy?.line_height || 'default',
    },
    browser_policy: {
      home_url_enabled: Boolean(input.browser_policy?.home_url_enabled),
      home_url: String(input.browser_policy?.home_url || ''),
      allowed_domains_enabled: Boolean(input.browser_policy?.allowed_domains_enabled),
      allowed_domains: String(input.browser_policy?.allowed_domains || ''),
    },
  }
}

function boolOverrideValue(value) {
  if (value === true || value === 'true') return 'true'
  if (value === false || value === 'false') return 'false'
  return 'default'
}

function currentStudentOverrideDrafts() {
  if (!elements.assignmentStudentOverrideList) {
    return []
  }

  return [...elements.assignmentStudentOverrideList.querySelectorAll('[data-student-override-id]')]
    .map((card) => createStudentOverrideDraft({
      id: card.dataset.studentOverrideId,
      student_name: card.querySelector('[data-override-student-name]')?.value || '',
      temporary_access_enabled: card.querySelector('[data-override-temp-enabled]')?.checked,
      temporary_access_until: card.querySelector('[data-override-temp-value]')?.value || '',
      policy: {
        allow_dictation: card.querySelector('[data-override-policy="allow_dictation"]')?.value,
        copy_paste_allowed: card.querySelector('[data-override-policy="copy_paste_allowed"]')?.value,
        printing_allowed: card.querySelector('[data-override-policy="printing_allowed"]')?.value,
        export_allowed: card.querySelector('[data-override-policy="export_allowed"]')?.value,
        images_allowed: card.querySelector('[data-override-policy="images_allowed"]')?.value,
        citations_required: card.querySelector('[data-override-policy="citations_required"]')?.value,
        require_lockdown: card.querySelector('[data-override-policy="require_lockdown"]')?.value,
        require_fullscreen: card.querySelector('[data-override-policy="require_fullscreen"]')?.value,
        browser_enabled: card.querySelector('[data-override-policy="browser_enabled"]')?.value,
      },
      editor_policy: {
        font_family: card.querySelector('[data-override-editor="font_family"]')?.value,
        font_size: card.querySelector('[data-override-editor="font_size"]')?.value,
        line_height: card.querySelector('[data-override-editor="line_height"]')?.value,
      },
      browser_policy: {
        home_url_enabled: card.querySelector('[data-override-home-enabled]')?.checked,
        home_url: card.querySelector('[data-override-home-value]')?.value || '',
        allowed_domains_enabled: card.querySelector('[data-override-domains-enabled]')?.checked,
        allowed_domains: card.querySelector('[data-override-domains-value]')?.value || '',
      },
    }))
}

function renderStudentOverrideSuggestions() {
  if (!elements.assignmentStudentOverrideSuggestions) return
  elements.assignmentStudentOverrideSuggestions.innerHTML = knownStudentsForClassroom()
    .map((studentName) => `<option value="${escapeHtml(studentName)}"></option>`)
    .join('')
}

function overrideBooleanSelect(field, label, value) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-override-policy="${escapeHtml(field)}">
        <option value="default"${value === 'default' ? ' selected' : ''}>Use default</option>
        <option value="true"${value === 'true' ? ' selected' : ''}>Allow</option>
        <option value="false"${value === 'false' ? ' selected' : ''}>Block</option>
      </select>
    </label>
  `
}

function overrideSelect(field, label, value, options, attributeName) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <select data-override-${escapeHtml(attributeName)}="${escapeHtml(field)}">
        <option value="default"${value === 'default' ? ' selected' : ''}>Use default</option>
        ${options
          .map(([optionValue, optionLabel]) => `
            <option value="${escapeHtml(optionValue)}"${String(value) === String(optionValue) ? ' selected' : ''}>
              ${escapeHtml(optionLabel)}
            </option>
          `)
          .join('')}
      </select>
    </label>
  `
}

function renderStudentOverrideCards(drafts = assignmentStudentOverrideDrafts) {
  assignmentStudentOverrideDrafts = drafts.map((draft) => createStudentOverrideDraft(draft))
  renderStudentOverrideSuggestions()

  if (!elements.assignmentStudentOverrideList) {
    return
  }

  if (!assignmentStudentOverrideDrafts.length) {
    elements.assignmentStudentOverrideList.innerHTML =
      '<div class="linked-assignment-empty">No student-specific overrides yet.</div>'
    return
  }

  elements.assignmentStudentOverrideList.innerHTML = assignmentStudentOverrideDrafts
    .map((draft) => `
      <article class="student-override-card" data-student-override-id="${escapeHtml(draft.id)}">
        <div class="student-override-header">
          <label>
            <span>Student name</span>
            <input
              type="text"
              list="assignment-student-override-suggestions"
              data-override-student-name
              placeholder="Ada Lovelace"
              value="${escapeHtml(draft.student_name)}"
            />
          </label>
          <button class="button button-secondary small-button" type="button" data-remove-student-override="${escapeHtml(draft.id)}">
            Remove
          </button>
        </div>
        <div class="student-override-grid">
          <label class="student-override-check">
            <input type="checkbox" data-override-temp-enabled ${draft.temporary_access_enabled ? 'checked' : ''} />
            <span>Override temporary access</span>
          </label>
          <label>
            <span>Temporary access until</span>
            <input
              type="datetime-local"
              data-override-temp-value
              ${draft.temporary_access_enabled ? '' : 'disabled'}
              value="${escapeHtml(draft.temporary_access_until)}"
            />
          </label>
        </div>
        <div class="student-override-grid">
          ${STUDENT_OVERRIDE_BOOLEAN_FIELDS
            .map(([field, label]) => overrideBooleanSelect(field, label, draft.policy[field]))
            .join('')}
        </div>
        <div class="student-override-grid">
          ${overrideSelect('font_family', 'Font', draft.editor_policy.font_family, STUDENT_OVERRIDE_FONT_OPTIONS, 'editor')}
          ${overrideSelect(
            'font_size',
            'Font size',
            draft.editor_policy.font_size,
            STUDENT_OVERRIDE_FONT_SIZE_OPTIONS.map((value) => [value, `${value} px`]),
            'editor',
          )}
          ${overrideSelect('line_height', 'Line spacing', draft.editor_policy.line_height, STUDENT_OVERRIDE_LINE_HEIGHT_OPTIONS, 'editor')}
        </div>
        <div class="student-override-grid">
          <label class="student-override-check">
            <input type="checkbox" data-override-home-enabled ${draft.browser_policy.home_url_enabled ? 'checked' : ''} />
            <span>Override browser home URL</span>
          </label>
          <label>
            <span>Home URL</span>
            <input
              type="url"
              data-override-home-value
              ${draft.browser_policy.home_url_enabled ? '' : 'disabled'}
              placeholder="https://example.com"
              value="${escapeHtml(draft.browser_policy.home_url)}"
            />
          </label>
          <label class="student-override-check">
            <input type="checkbox" data-override-domains-enabled ${draft.browser_policy.allowed_domains_enabled ? 'checked' : ''} />
            <span>Override allowed domains</span>
          </label>
          <label class="student-override-full">
            <span>Allowed domains (one per line)</span>
            <textarea
              rows="3"
              data-override-domains-value
              ${draft.browser_policy.allowed_domains_enabled ? '' : 'disabled'}
              placeholder="example.com&#10;wikipedia.org"
            >${escapeHtml(draft.browser_policy.allowed_domains)}</textarea>
          </label>
        </div>
      </article>
    `)
    .join('')

  elements.assignmentStudentOverrideList.querySelectorAll('[data-remove-student-override]').forEach((button) => {
    button.addEventListener('click', () => {
      assignmentStudentOverrideDrafts = currentStudentOverrideDrafts().filter(
        (draft) => draft.id !== button.dataset.removeStudentOverride,
      )
      renderStudentOverrideCards(assignmentStudentOverrideDrafts)
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-temp-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-temp-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-home-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-home-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })

  elements.assignmentStudentOverrideList.querySelectorAll('[data-override-domains-enabled]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const card = checkbox.closest('[data-student-override-id]')
      const input = card?.querySelector('[data-override-domains-value]')
      if (input) {
        input.disabled = !checkbox.checked
      }
    })
  })
}

function selectedStudentOverridesFromForm() {
  const studentOverrides = {}
  const studentTemporaryAccessUntil = {}

  for (const draft of currentStudentOverrideDrafts()) {
    const normalizedKey = normalizeStudentOverrideKey(draft.student_name)
    if (!normalizedKey) {
      continue
    }

    if (draft.temporary_access_enabled) {
      const iso = toIsoFromDateTimeLocal(draft.temporary_access_until)
      if (iso) {
        studentTemporaryAccessUntil[normalizedKey] = iso
      }
    }

    const policy = {}
    for (const [field] of STUDENT_OVERRIDE_BOOLEAN_FIELDS) {
      if (field === 'browser_enabled') {
        continue
      }
      if (draft.policy[field] !== 'default') {
        policy[field] = draft.policy[field] === 'true'
      }
    }

    const editorPolicy = {}
    if (draft.editor_policy.font_family !== 'default') {
      editorPolicy.font_family = draft.editor_policy.font_family
    }
    if (draft.editor_policy.font_size !== 'default') {
      editorPolicy.font_size = Number(draft.editor_policy.font_size)
    }
    if (draft.editor_policy.line_height !== 'default') {
      editorPolicy.line_height = draft.editor_policy.line_height
    }

    const browserPolicy = {}
    if (draft.policy.browser_enabled !== 'default') {
      browserPolicy.browser_enabled = draft.policy.browser_enabled === 'true'
    }
    if (draft.browser_policy.home_url_enabled) {
      browserPolicy.home_url = draft.browser_policy.home_url
    }
    if (draft.browser_policy.allowed_domains_enabled) {
      browserPolicy.allowed_domains = draft.browser_policy.allowed_domains
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)
    }

    if (Object.keys(policy).length || Object.keys(editorPolicy).length || Object.keys(browserPolicy).length) {
      studentOverrides[normalizedKey] = {
        student_name: draft.student_name.trim(),
        ...(Object.keys(policy).length ? { policy } : {}),
        ...(Object.keys(editorPolicy).length ? { editor_policy: editorPolicy } : {}),
        ...(Object.keys(browserPolicy).length ? { browser_policy: browserPolicy } : {}),
      }
    }
  }

  return { studentOverrides, studentTemporaryAccessUntil }
}

function draftsFromAssignmentStudentOverrides(assignment) {
  const settingsOverrides = assignment?.student_overrides && typeof assignment.student_overrides === 'object'
    ? assignment.student_overrides
    : {}
  const temporaryOverrides = assignment?.student_temporary_access_until && typeof assignment.student_temporary_access_until === 'object'
    ? assignment.student_temporary_access_until
    : {}
  const keys = [...new Set([...Object.keys(settingsOverrides), ...Object.keys(temporaryOverrides)])]

  return keys.map((key) => {
    const settings = settingsOverrides[key] || {}
    return createStudentOverrideDraft({
      student_name: settings.student_name || key,
      temporary_access_enabled: Object.hasOwn(temporaryOverrides, key),
      temporary_access_until: temporaryOverrides[key] ? localDateTimeInputValue(temporaryOverrides[key]) : '',
      policy: {
        allow_dictation: boolOverrideValue(settings.policy?.allow_dictation),
        copy_paste_allowed: boolOverrideValue(settings.policy?.copy_paste_allowed),
        printing_allowed: boolOverrideValue(settings.policy?.printing_allowed),
        export_allowed: boolOverrideValue(settings.policy?.export_allowed),
        images_allowed: boolOverrideValue(settings.policy?.images_allowed),
        citations_required: boolOverrideValue(settings.policy?.citations_required),
        require_lockdown: boolOverrideValue(settings.policy?.require_lockdown),
        require_fullscreen: boolOverrideValue(settings.policy?.require_fullscreen),
        browser_enabled: boolOverrideValue(settings.browser_policy?.browser_enabled),
      },
      editor_policy: {
        font_family: settings.editor_policy?.font_family || 'default',
        font_size: settings.editor_policy?.font_size ? String(settings.editor_policy.font_size) : 'default',
        line_height: settings.editor_policy?.line_height || 'default',
      },
      browser_policy: {
        home_url_enabled: Object.hasOwn(settings.browser_policy || {}, 'home_url'),
        home_url: settings.browser_policy?.home_url || '',
        allowed_domains_enabled: Object.hasOwn(settings.browser_policy || {}, 'allowed_domains'),
        allowed_domains: Array.isArray(settings.browser_policy?.allowed_domains)
          ? settings.browser_policy.allowed_domains.join('\n')
          : '',
      },
    })
  })
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
  field.value = localDateTimeInputValue(todayAtLocalTime(hour, minute))
  updateAssignmentFormGuidance()
}

function selectedTimeParts(input, fallbackHour = 15, fallbackMinute = 0) {
  return parseTimeParts(input?.value, fallbackHour, fallbackMinute)
}

async function extendSelectedAssignmentToToday(hour, minute = 0) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const target = todayAtLocalTime(hour, minute)
  if (target.getTime() < Date.now()) {
    window.alert('The selected time today has already passed.')
    return
  }

  const updatedAssignment = await request(`/api/edu/assignments/${assignment.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      temporary_access_until: todayAtLocalTimeIso(hour, minute),
    }),
  })

  dashboardState = {
    ...dashboardState,
    assignments: getAssignments().map((item) => (item.id === updatedAssignment.id ? updatedAssignment : item)),
  }
  selectedAssignmentId = updatedAssignment.id
  renderView()
}

function studentSpecificExtensionFor(assignment, studentName) {
  const key = normalizeStudentOverrideKey(studentName)
  if (!key) {
    return null
  }
  return assignment?.student_temporary_access_until?.[key] || null
}

async function extendSelectedAssignmentForStudentToToday(studentName, hour, minute = 0) {
  const assignment = getSelectedAssignment()
  if (!assignment) {
    window.alert('Select an assignment first.')
    return
  }

  const normalizedKey = normalizeStudentOverrideKey(studentName)
  if (!normalizedKey) {
    window.alert('That student name is missing.')
    return
  }

  const target = todayAtLocalTime(hour, minute)
  if (target.getTime() < Date.now()) {
    window.alert('The selected time today has already passed.')
    return
  }

  const updatedAssignment = await request(`/api/edu/assignments/${assignment.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      student_temporary_access_until: {
        ...(assignment.student_temporary_access_until || {}),
        [normalizedKey]: todayAtLocalTimeIso(hour, minute),
      },
    }),
  })

  dashboardState = {
    ...dashboardState,
    assignments: getAssignments().map((item) => (item.id === updatedAssignment.id ? updatedAssignment : item)),
  }
  selectedAssignmentId = updatedAssignment.id
  renderView()
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

function selectedLinkedAssignmentIdsFromForm() {
  if (!elements.assignmentForm) return []
  return [...new Set(new FormData(elements.assignmentForm).getAll('linked_assignment_ids').map((value) => String(value)))]
}

function knownStudentsForClassroom(classroomId = elements.assignmentCourseSelect?.value || selectedClassroomId || '') {
  const classroom = getClassrooms().find((item) => item.id === classroomId)
  const classroomStudents = Array.isArray(classroom?.students) ? classroom.students : []
  const liveStudents = getLiveSessions()
    .filter((session) => session.classroom === classroom?.name)
    .map((session) => session.student_name)
  const assignedStudents = getAssignmentsForClassroom(classroomId).flatMap((assignment) => assignment.assigned_students || [])

  return [...new Set(
    [...classroomStudents, ...liveStudents, ...assignedStudents]
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b))
}

function selectedAssignedStudentsFromForm() {
  if (!elements.assignmentForm) return []
  const checked = new FormData(elements.assignmentForm).getAll('assigned_students').map((value) => String(value))
  const extra = String(elements.assignmentAssignedExtra?.value || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set([...checked, ...extra])]
}

function renderAssignedStudentOptions(selectedNames = null) {
  if (!elements.assignmentAssignedOptions) return
  const knownStudents = knownStudentsForClassroom()
  renderStudentOverrideSuggestions()
  const selected = new Set((selectedNames || selectedAssignedStudentsFromForm()).map((value) => String(value).trim()))

  if (!knownStudents.length) {
    elements.assignmentAssignedOptions.innerHTML =
      '<div class="linked-assignment-empty">No student names have reached this class yet. You can still type names below manually.</div>'
    return
  }

  elements.assignmentAssignedOptions.innerHTML = knownStudents
    .map((studentName) => `
      <label class="checkbox-label linked-assignment-option">
        <input
          type="checkbox"
          name="assigned_students"
          value="${escapeHtml(studentName)}"
          ${selected.has(studentName) ? 'checked' : ''}
        />
        <span><strong>${escapeHtml(studentName)}</strong></span>
      </label>
    `)
    .join('')
}

function renderLinkedAssignmentOptions(selectedIds = null) {
  if (!elements.assignmentLinkedOptions) return
  const classroomId = elements.assignmentCourseSelect?.value || selectedClassroomId || ''
  const currentAssignmentId = elements.assignmentIdInput?.value || ''
  const selected = new Set((selectedIds || selectedLinkedAssignmentIdsFromForm()).map((value) => String(value)))
  const options = getAssignmentsForClassroom(classroomId).filter((assignment) => assignment.id !== currentAssignmentId)

  if (!options.length) {
    elements.assignmentLinkedOptions.innerHTML =
      '<div class="linked-assignment-empty">No previous assignments in this class yet.</div>'
    return
  }

  elements.assignmentLinkedOptions.innerHTML = options
    .map(
      (assignment) => `
        <label class="checkbox-label linked-assignment-option">
          <input
            type="checkbox"
            name="linked_assignment_ids"
            value="${escapeHtml(assignment.id)}"
            ${selected.has(assignment.id) ? 'checked' : ''}
          />
          <span>
            <strong>${escapeHtml(assignment.title)}</strong>
            <span class="muted">${escapeHtml(assignment.course || assignment.classroom_name || 'Assignment')}</span>
            <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
          </span>
        </label>
      `,
    )
    .join('')
}

function createRubricDraft(criterion = {}) {
  return {
    id: criterion.id || `rubric_${Math.random().toString(36).slice(2, 10)}`,
    title: criterion.title || '',
    description: criterion.description || '',
    points: Number(criterion.points || 4),
  }
}

function selectedRubricFromForm() {
  if (!elements.assignmentRubricList) return []
  return [...elements.assignmentRubricList.querySelectorAll('[data-rubric-row]')]
    .map((row) => ({
      id: row.dataset.rubricId || undefined,
      title: row.querySelector('[data-rubric-title]')?.value.trim() || '',
      description: row.querySelector('[data-rubric-description]')?.value.trim() || '',
      points: Number(row.querySelector('[data-rubric-points]')?.value || 4),
    }))
    .filter((criterion) => criterion.title)
}

function renderRubricBuilder(criteria = null) {
  if (!elements.assignmentRubricList) return
  const drafts = (criteria || selectedRubricFromForm()).map(createRubricDraft)

  elements.assignmentRubricList.innerHTML = drafts.length
    ? drafts
        .map(
          (criterion) => `
            <div class="rubric-builder-row" data-rubric-row data-rubric-id="${escapeHtml(criterion.id)}">
              <label>
                <span>Criterion</span>
                <input data-rubric-title type="text" value="${escapeHtml(criterion.title)}" placeholder="Thesis, evidence, analysis..." />
              </label>
              <label>
                <span>Points</span>
                <input data-rubric-points type="number" min="1" max="100" value="${escapeHtml(criterion.points)}" />
              </label>
              <label class="rubric-description-field">
                <span>Description</span>
                <textarea data-rubric-description rows="2" placeholder="What earns full credit?">${escapeHtml(criterion.description)}</textarea>
              </label>
              <button class="button button-secondary small-button" type="button" data-remove-rubric>Remove</button>
            </div>
          `,
        )
        .join('')
    : '<div class="linked-assignment-empty">No rubric criteria yet.</div>'

  elements.assignmentRubricList.querySelectorAll('[data-remove-rubric]').forEach((button) => {
    button.addEventListener('click', () => {
      button.closest('[data-rubric-row]')?.remove()
      if (!elements.assignmentRubricList.querySelector('[data-rubric-row]')) {
        renderRubricBuilder([])
      }
      updateAssignmentFormGuidance()
    })
  })
}

function assignmentAudienceLabel(assignment) {
  const assignedStudents = Array.isArray(assignment?.assigned_students) ? assignment.assigned_students : []
  if (!assignedStudents.length) {
    return 'Whole class'
  }
  return `${assignedStudents.length} assigned student${assignedStudents.length === 1 ? '' : 's'}`
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
        <button class="selection-card classroom-card${selected ? ' is-selected' : ''}" type="button" data-classroom-id="${escapeHtml(classroom.id)}">
          <span class="selection-card-top">
            <span class="selection-title">${escapeHtml(classroom.name)}</span>
            <span class="selection-count">${assignments.length}</span>
          </span>
          <span class="selection-meta">${assignments.length} assignment${assignments.length === 1 ? '' : 's'}</span>
          <span class="selection-meta">Join code ${escapeHtml(classroom.join_code || 'No join code')}</span>
          <span class="selection-card-action-label">Open assignments</span>
        </button>
      `
    })
    .join('')

  elements.classroomGrid.querySelectorAll('[data-classroom-id]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedClassroomId = button.dataset.classroomId
      selectedAssignmentId = null
      currentView = 'assignments'
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
  if (elements.assignmentStageMeta) {
    elements.assignmentStageMeta.textContent = `${assignments.length} assignment${assignments.length === 1 ? '' : 's'} available`
  }

  if (!assignments.length) {
    elements.assignmentGrid.innerHTML = `<div class="selection-empty">No assignments yet for this class. Create one when you are ready.</div>`
    return
  }

  elements.assignmentGrid.innerHTML = assignments
    .map((assignment, index) => {
      const selected = assignment.id === selectedAssignmentId
      return `
        <button class="selection-card assignment-card${selected ? ' is-selected' : ''}" type="button" data-assignment-id="${escapeHtml(assignment.id)}">
          <span class="assignment-card-kicker">Assignment ${String(index + 1).padStart(2, '0')}</span>
          <span class="selection-title">${escapeHtml(assignment.title)}</span>
          <span class="selection-meta">${escapeHtml(assignment.course || classroom.name)}</span>
          <span class="selection-meta">${escapeHtml(assignmentAudienceLabel(assignment))}</span>
          <span class="selection-meta">${escapeHtml(formatWindowSummary(assignment))}</span>
          <span class="selection-card-action-label">View students</span>
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

function renderEditActivitySparkline(activity) {
  const maxCount = Math.max(1, ...activity.buckets)
  const bars = activity.buckets
    .map((count, index) => {
      const height = count > 0 ? Math.max(12, Math.round((count / maxCount) * 100)) : 8
      return `<span class="edit-activity-bar" style="height:${height}%" title="Minute ${index + 1}: ${count} edit${
        count === 1 ? '' : 's'
      }"></span>`
    })
    .join('')
  const label = activity.totalEdits
    ? `${activity.totalEdits} edit${activity.totalEdits === 1 ? '' : 's'} in the last 5 minutes`
    : 'No recent edits in the last 5 minutes'
  return `
    <div class="edit-activity-block">
      <div class="edit-activity-meta">${escapeHtml(label)}</div>
      <div class="edit-activity-graph" aria-label="${escapeHtml(label)}">${bars}</div>
    </div>
  `
}

function selectedSessionReviewSummary(session, assignment) {
  const summary = reviewSummaryForSession(session, assignment)
  const badges = []
  if (summary.grading.grade_label) {
    badges.push(badge(`Grade ${summary.grading.grade_label}`, 'good'))
  } else if (summary.grading.grade_score) {
    badges.push(badge(`Score ${summary.grading.grade_score}`, 'good'))
  }
  if (summary.totalPoints > 0) {
    badges.push(badge(`${summary.earnedPoints}/${summary.totalPoints} rubric`, 'neutral'))
  }
  if (summary.annotationCount > 0) {
    badges.push(
      badge(
        `${summary.annotationCount} inline ${summary.annotationCount === 1 ? 'note' : 'notes'}`,
        'warn',
      ),
    )
  }
  if (summary.grading.returned_for_revision) {
    badges.push(badge('Returned for revision', 'danger'))
  }
  return badges.length ? `<div class="student-card-review-summary">${badges.join('')}</div>` : ''
}

function buildReviewPayload() {
  if (!reviewState) return null
  return {
    rubric_scores: { ...reviewState.rubricScores },
    teacher_comment: reviewState.teacherComment,
    suggested_revisions: reviewState.suggestedRevisions,
    returned_for_revision: reviewState.returnedForRevision,
    grade_label: reviewState.gradeLabel,
    grade_score: reviewState.gradeScore === '' ? null : Number(reviewState.gradeScore),
    inline_annotations: reviewState.inlineAnnotations.map((annotation) => ({
      ...annotation,
      updated_at: annotation.updated_at || annotation.created_at || new Date().toISOString(),
    })),
  }
}

function renderReviewSyncStatus() {
  if (!elements.reviewSyncStatus) return
  elements.reviewSyncStatus.classList.remove('is-saving', 'is-saved', 'is-error')
  if (!reviewState) {
    elements.reviewSyncStatus.textContent = 'Saved'
    return
  }
  if (reviewState.saveState === 'error') {
    elements.reviewSyncStatus.textContent = 'Sync failed'
    elements.reviewSyncStatus.classList.add('is-error')
    return
  }
  if (reviewState.dirty || reviewState.saveState === 'saving') {
    elements.reviewSyncStatus.textContent = 'Syncing…'
    elements.reviewSyncStatus.classList.add('is-saving')
    return
  }
  if (reviewState.updatedAt) {
    elements.reviewSyncStatus.textContent = `Saved ${timeAgoLabel(reviewState.updatedAt)}`
    elements.reviewSyncStatus.classList.add('is-saved')
    return
  }
  elements.reviewSyncStatus.textContent = 'Not yet saved'
}

function markReviewDirty() {
  if (!reviewState) return
  reviewState.dirty = true
  reviewState.saveState = 'saving'
  renderReviewSyncStatus()
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
  }
  reviewSaveTimer = window.setTimeout(() => {
    saveCurrentReview().catch(() => {})
  }, 500)
}

async function saveCurrentReview() {
  if (!reviewState || !reviewState.dirty || reviewSaveInFlight) {
    return reviewSavePromise
  }
  const sessionId = reviewState.sessionId
  const payload = buildReviewPayload()
  reviewSaveInFlight = true
  reviewSavePromise = request(`/api/edu/live-sessions/${encodeURIComponent(sessionId)}/grading`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
    .then((updatedSession) => {
      dashboardState = {
        ...dashboardState,
        live_sessions: mergeById(getLiveSessions(), [updatedSession]),
      }
      if (reviewState?.sessionId === sessionId) {
        const grading = normalizedSessionGrading(updatedSession)
        reviewState.updatedAt = grading.updated_at
        reviewState.updatedBy = grading.actor_name || grading.actor_email || ''
        reviewState.dirty = false
        reviewState.saveState = 'saved'
      }
      renderReviewSyncStatus()
      renderStudentCards({ skipReviewWorkspace: true })
    })
    .catch((error) => {
      if (reviewState?.sessionId === sessionId) {
        reviewState.saveState = 'error'
      }
      renderReviewSyncStatus()
      throw error
    })
    .finally(() => {
      reviewSaveInFlight = false
      reviewSavePromise = null
    })
  return reviewSavePromise
}

async function flushReviewSave() {
  if (reviewSaveTimer) {
    clearTimeout(reviewSaveTimer)
    reviewSaveTimer = null
  }
  if (reviewState?.dirty) {
    await saveCurrentReview()
  } else if (reviewSavePromise) {
    await reviewSavePromise
  }
}

function clearReviewComposer() {
  if (!reviewState) return
  reviewState.composerMode = ''
  reviewState.composerNote = ''
  reviewState.composerReplacement = ''
  if (elements.reviewComposerNote) elements.reviewComposerNote.value = ''
  if (elements.reviewComposerReplacement) elements.reviewComposerReplacement.value = ''
  renderReviewSelectionUi()
}

function renderReviewSelectionUi() {
  if (!reviewState) return
  const selection = reviewState.selection
  elements.reviewSelectionCount.textContent = selection
    ? `${selection.end - selection.start} char${selection.end - selection.start === 1 ? '' : 's'} selected`
    : 'No text selected'
  elements.reviewSelectionQuote.textContent = selection
    ? selection.text
    : 'Select text in the draft to add a comment or suggestion.'
  const composerOpen = Boolean(selection && reviewState.composerMode)
  elements.reviewComposer.hidden = !composerOpen
  elements.reviewReplacementField.hidden = reviewState.composerMode !== 'suggestion'
  elements.reviewComposerLabel.textContent =
    reviewState.composerMode === 'suggestion' ? 'New suggestion' : 'New comment'
  elements.reviewCommentMode.classList.toggle('is-selected', reviewState.composerMode === 'comment')
  elements.reviewSuggestMode.classList.toggle('is-selected', reviewState.composerMode === 'suggestion')
}

function beginReviewComposer(mode) {
  if (!reviewState?.selection) return
  reviewState.composerMode = mode
  reviewState.composerNote = ''
  reviewState.composerReplacement = ''
  elements.reviewComposerNote.value = ''
  elements.reviewComposerReplacement.value = ''
  renderReviewSelectionUi()
  elements.reviewComposerNote.focus()
}

function annotationsOverlap(start, end, excludeId = null) {
  return reviewState?.inlineAnnotations.some(
    (annotation) =>
      annotation.id !== excludeId &&
      Math.max(start, annotation.start) < Math.min(end, annotation.end),
  )
}

function addReviewAnnotation() {
  if (!reviewState?.selection || !reviewState.composerMode) return
  const { start, end, text } = reviewState.selection
  if (annotationsOverlap(start, end)) {
    window.alert('Inline comments and suggestions cannot overlap yet. Choose a different span of text.')
    return
  }
  const note = elements.reviewComposerNote.value.trim()
  const replacement = elements.reviewComposerReplacement.value.trim()
  if (!note) {
    window.alert('Add a short note before saving the annotation.')
    return
  }
  if (reviewState.composerMode === 'suggestion' && !replacement) {
    window.alert('Add the suggested replacement text first.')
    return
  }
  const timestamp = new Date().toISOString()
  reviewState.inlineAnnotations = [...reviewState.inlineAnnotations, normalizedInlineAnnotation({
    type: reviewState.composerMode,
    start,
    end,
    quote: text,
    note,
    replacement,
    created_at: timestamp,
    updated_at: timestamp,
  })].sort((a, b) => a.start - b.start || a.end - b.end)
  reviewState.selection = null
  selectedAnnotationId = null
  clearReviewComposer()
  markReviewDirty()
  renderReviewWorkspace(getSelectedAssignment())
}

function deleteReviewAnnotation(annotationId) {
  if (!reviewState) return
  reviewState.inlineAnnotations = reviewState.inlineAnnotations.filter((annotation) => annotation.id !== annotationId)
  if (selectedAnnotationId === annotationId) {
    selectedAnnotationId = null
  }
  markReviewDirty()
  renderReviewWorkspace(getSelectedAssignment())
}

function annotationDisplayState(annotation, text) {
  const normalized = normalizedInlineAnnotation(annotation)
  const direct = text.slice(normalized.start, normalized.end)
  const quote = normalized.quote || direct
  if (!quote) {
    return { ...normalized, stale: false }
  }
  if (direct === quote) {
    return { ...normalized, quote, stale: false }
  }
  const firstIndex = text.indexOf(quote)
  if (firstIndex !== -1 && text.indexOf(quote, firstIndex + quote.length) === -1) {
    return {
      ...normalized,
      start: firstIndex,
      end: firstIndex + quote.length,
      quote,
      stale: false,
    }
  }
  return {
    ...normalized,
    quote,
    stale: true,
  }
}

function renderDraftSurface(text, annotations) {
  const safeText = String(text || '')
  if (!safeText) {
    elements.reviewDraftSurface.innerHTML = '<span class="student-meta">(empty draft)</span>'
    return
  }

  const displayAnnotations = annotations
    .map((annotation) => annotationDisplayState(annotation, safeText))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  let cursor = 0
  const parts = []
  for (const annotation of displayAnnotations) {
    const start = Math.max(0, Math.min(annotation.start, safeText.length))
    const end = Math.max(start, Math.min(annotation.end, safeText.length))
    if (start > cursor) {
      parts.push(escapeHtml(safeText.slice(cursor, start)))
    }
    const classes = [
      'review-highlight',
      annotation.type === 'suggestion' ? 'review-highlight-suggestion' : 'review-highlight-comment',
    ]
    if (annotation.stale) {
      classes.push('review-highlight-stale')
    }
    if (annotation.id === selectedAnnotationId) {
      classes.push('is-selected')
    }
    parts.push(
      `<span class="${classes.join(' ')}" data-annotation-id="${escapeHtml(annotation.id)}">${escapeHtml(
        safeText.slice(start, end) || annotation.quote,
      )}</span>`,
    )
    cursor = end
  }
  if (cursor < safeText.length) {
    parts.push(escapeHtml(safeText.slice(cursor)))
  }
  elements.reviewDraftSurface.innerHTML = parts.join('')
}

function renderReviewAnnotationList(session) {
  if (!reviewState) return
  const text = String(session?.current_text || '')
  const annotations = reviewState.inlineAnnotations
    .map((annotation) => annotationDisplayState(annotation, text))
    .sort((a, b) => a.start - b.start || a.end - b.end)

  elements.reviewAnnotationMeta.textContent = annotations.length
    ? `${annotations.length} inline ${annotations.length === 1 ? 'note' : 'notes'}`
    : 'No inline notes yet.'

  if (!annotations.length) {
    elements.reviewAnnotationList.innerHTML =
      '<div class="review-annotation-empty">Use Comment or Suggest on selected text to anchor feedback directly in the draft.</div>'
    return
  }

  elements.reviewAnnotationList.innerHTML = annotations
    .map((annotation, index) => `
      <article class="review-annotation-card${annotation.id === selectedAnnotationId ? ' is-selected' : ''}" data-review-annotation="${escapeHtml(annotation.id)}">
        <div class="review-annotation-head">
          <div class="review-annotation-tag review-annotation-tag-${annotation.type}">
            ${escapeHtml(annotation.type === 'suggestion' ? `Suggestion ${String(index + 1).padStart(2, '0')}` : `Comment ${String(index + 1).padStart(2, '0')}`)}
          </div>
          <div class="student-meta">${annotation.stale ? 'Anchor drifted after new writing' : 'Anchored in draft'}</div>
        </div>
        <div class="review-annotation-quote">${escapeHtml(annotation.quote || text.slice(annotation.start, annotation.end) || '(selection unavailable)')}</div>
        ${
          annotation.type === 'suggestion'
            ? `<div class="review-annotation-replacement"><strong>Suggested replacement:</strong> ${escapeHtml(annotation.replacement || '')}</div>`
            : ''
        }
        <div class="review-annotation-note">${escapeHtml(annotation.note || '')}</div>
        <div class="review-annotation-actions">
          <button class="button button-secondary small-button" type="button" data-focus-annotation="${escapeHtml(annotation.id)}">Show in draft</button>
          <button class="button button-secondary small-button" type="button" data-delete-annotation="${escapeHtml(annotation.id)}">Delete</button>
        </div>
      </article>
    `)
    .join('')

  elements.reviewAnnotationList.querySelectorAll('[data-focus-annotation]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedAnnotationId = button.dataset.focusAnnotation || null
      renderReviewWorkspace(getSelectedAssignment())
      elements.reviewDraftSurface.querySelector(`[data-annotation-id="${CSS.escape(selectedAnnotationId)}"]`)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      })
    })
  })

  elements.reviewAnnotationList.querySelectorAll('[data-delete-annotation]').forEach((button) => {
    button.addEventListener('click', () => deleteReviewAnnotation(button.dataset.deleteAnnotation || ''))
  })
}

function renderReviewRubric(assignment) {
  if (!reviewState) return
  const rubric = Array.isArray(assignment?.rubric) ? assignment.rubric : []
  if (!rubric.length) {
    elements.reviewRubricList.innerHTML =
      '<div class="selection-empty">No rubric is attached to this assignment yet.</div>'
    elements.reviewRubricTotal.textContent = ''
    return
  }

  const total = rubric.reduce((sum, criterion) => sum + Math.max(1, Number(criterion.points || 0)), 0)
  const earned = rubric.reduce(
    (sum, criterion) => sum + Number(reviewState.rubricScores[criterion.id] || 0),
    0,
  )
  elements.reviewRubricTotal.textContent = `${earned}/${total} points selected`
  elements.reviewRubricList.innerHTML = rubric
    .map((criterion) => {
      const max = Math.max(1, Number(criterion.points || 4))
      const options = Array.from({ length: max + 1 }, (_, score) => {
        const selected = Number(reviewState.rubricScores[criterion.id] || 0) === score ? ' selected' : ''
        return `<option value="${score}"${selected}>${score}/${max}</option>`
      }).join('')
      return `
        <label class="review-rubric-row">
          <span class="review-rubric-copy">
            <strong>${escapeHtml(criterion.title)}</strong>
            ${criterion.description ? `<em>${escapeHtml(criterion.description)}</em>` : ''}
          </span>
          <select data-review-rubric-score="${escapeHtml(criterion.id)}">${options}</select>
        </label>
      `
    })
    .join('')

  elements.reviewRubricList.querySelectorAll('[data-review-rubric-score]').forEach((select) => {
    select.addEventListener('change', () => {
      reviewState.rubricScores[select.dataset.reviewRubricScore] = Number(select.value || 0)
      markReviewDirty()
      renderReviewRubric(assignment)
      renderStudentCards({ skipReviewWorkspace: true })
    })
  })
}

function renderAssignmentAudits() {
  if (!elements.assignmentAuditList) return
  const audits = [...getSelectedAssignmentAudits()].sort((a, b) =>
    String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')),
  )
  if (!audits.length) {
    elements.assignmentAuditList.innerHTML = '<div class="selection-empty">No teacher changes recorded for this assignment yet.</div>'
    return
  }
  elements.assignmentAuditList.innerHTML = audits
    .slice(0, 8)
    .map((audit) => {
      const changes = (audit.changes || [])
        .slice(0, 4)
        .map(
          (change) => `<li><strong>${escapeHtml(change.label)}:</strong> ${escapeHtml(
            change.after == null ? 'cleared' : typeof change.after === 'object' ? JSON.stringify(change.after) : String(change.after),
          )}</li>`,
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

function renderReviewWorkspace(selectedAssignment) {
  if (!elements.reviewWorkspace) return
  const session = currentReviewSession()
  if (!session || !selectedAssignment) {
    reviewState = null
    selectedAnnotationId = null
    elements.reviewWorkspaceEmpty.hidden = false
    elements.reviewWorkspaceContent.hidden = true
    renderReviewSyncStatus()
    return
  }

  if (!reviewState || reviewState.sessionId !== session.id) {
    reviewState = createReviewStateFromSession(session)
    selectedAnnotationId = null
  }

  elements.reviewWorkspaceEmpty.hidden = true
  elements.reviewWorkspaceContent.hidden = false
  elements.reviewWorkspaceTitle.textContent = session.student_name
  elements.reviewWorkspaceMeta.textContent = `${selectedAssignment.title} • last student edit ${timeAgoLabel(
    session.last_activity_at,
  )}${reviewState.updatedBy ? ` • last teacher save by ${reviewState.updatedBy}` : ''}`
  elements.reviewGradeLabel.value = reviewState.gradeLabel
  elements.reviewGradeScore.value = reviewState.gradeScore
  elements.reviewTeacherComment.value = reviewState.teacherComment
  elements.reviewSuggestedRevisions.value = reviewState.suggestedRevisions
  elements.reviewReturned.checked = reviewState.returnedForRevision
  elements.reviewDraftMeta.textContent = session.current_text
    ? `Live draft is ${String(session.current_text).length} characters. Select text to anchor comments or suggestions.`
    : 'The student draft is still empty.'
  renderReviewRubric(selectedAssignment)
  renderDraftSurface(session.current_text, reviewState.inlineAnnotations)
  elements.reviewDraftSurface.querySelectorAll('[data-annotation-id]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedAnnotationId = node.dataset.annotationId || null
      renderReviewWorkspace(selectedAssignment)
    })
  })
  renderReviewAnnotationList(session)
  renderReviewSelectionUi()
  renderReviewSyncStatus()
}

function readReviewDraftSelection() {
  const root = elements.reviewDraftSurface
  const selection = window.getSelection()
  if (!root || !selection || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) return null
  const text = selection.toString()
  if (!text.trim()) return null
  const prefixRange = range.cloneRange()
  prefixRange.selectNodeContents(root)
  prefixRange.setEnd(range.startContainer, range.startOffset)
  const start = prefixRange.toString().length
  const end = start + text.length
  return {
    start,
    end,
    text,
  }
}

function handleReviewDraftSelection() {
  if (!reviewState) return
  reviewState.selection = readReviewDraftSelection()
  renderReviewSelectionUi()
}

async function selectReviewSession(sessionId) {
  if (!sessionId || selectedReviewSessionId === sessionId) return
  await flushReviewSave()
  selectedReviewSessionId = sessionId
  reviewState = null
  selectedAnnotationId = null
  renderStudentCards()
}

function renderMonitoringOverview(matchingSessions) {
  const now = Date.now()
  const activeSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active)
  const attentionSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).needsAttention)
  const unfocusedSessions = matchingSessions.filter((session) => deriveSessionRisk(session, now).active && !session.focused)
  const offlineSessions = matchingSessions.filter((session) => !deriveSessionRisk(session, now).active)
  const editActivity = aggregateRecentEditActivity(matchingSessions)

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
  elements.overviewEdits.textContent = String(editActivity.totalEdits)
  elements.overviewEditsMeta.textContent = editActivity.activeStudents
    ? `${editActivity.activeStudents} student${editActivity.activeStudents === 1 ? '' : 's'} changed text in the last 5 min`
    : 'No recent writing changes'
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

function renderStudentCards({ skipReviewWorkspace = false } = {}) {
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
    if (!skipReviewWorkspace) {
      renderReviewWorkspace(selectedAssignment)
    }
    return
  }

  if (selectedReviewSessionId && !matchingSessions.some((session) => session.id === selectedReviewSessionId)) {
    selectedReviewSessionId = matchingSessions[0]?.id || null
    reviewState = selectedReviewSessionId ? createReviewStateFromSession(currentReviewSession()) : null
    selectedAnnotationId = null
  }

  const visibleSessions = sortSessionsForDisplay(matchingSessions).filter(sessionMatchesFilter)

  if (!visibleSessions.length) {
    elements.sessionGrid.innerHTML = `<div class="student-empty">No student sessions match the current filter.</div>`
    if (!skipReviewWorkspace) {
      renderReviewWorkspace(selectedAssignment)
    }
    return
  }

  elements.sessionGrid.innerHTML = visibleSessions
    .map((session) => {
      const now = Date.now()
      const risk = deriveSessionRisk(session, now)
      const activity = recentEditActivity(session)
      const replayLink = session.replay_session_id
        ? `<a class="button button-secondary small-button" href="/edu/replay/${escapeHtml(session.replay_session_id)}" target="_blank" rel="noreferrer">Replay</a>`
        : ''
      const studentExtension = studentSpecificExtensionFor(selectedAssignment, session.student_name)
      const badges = [
        badge(sessionStatusLabel(session, now), risk.active ? (session.focused ? 'good' : 'warn') : 'danger'),
      ]
      const reviewSummary = selectedSessionReviewSummary(session, selectedAssignment)
      if (risk.violationCount > 0) {
        badges.push(badge(`${risk.violationCount} violation${risk.violationCount === 1 ? '' : 's'}`, 'danger'))
      }
      if (!session.hid_active) {
        badges.push(badge('HID waiting', 'warn'))
      }
      if (studentExtension) {
        badges.push(badge(`Extended until ${new Date(studentExtension).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'good'))
      }

      return `
        <article
          class="student-card student-card-risk-${risk.score >= 45 ? 'high' : risk.score >= 20 ? 'medium' : 'low'}${selectedReviewSessionId === session.id ? ' is-selected' : ''}"
          data-review-session="${escapeHtml(session.id)}"
        >
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
              <div class="section-label">Edit activity</div>
              ${renderEditActivitySparkline(activity)}
            </div>
            <div class="student-section">
              <div class="section-label">Current writing</div>
              <div class="student-text">${escapeHtml(session.current_text || '(empty)')}</div>
            </div>
            ${reviewSummary}
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
            <button
              class="button button-secondary small-button"
              type="button"
              data-extend-student="${escapeHtml(session.student_name)}"
            >
              Extend this student
            </button>
            <button
              class="button button-secondary small-button"
              type="button"
              data-open-review="${escapeHtml(session.id)}"
            >
              Review draft
            </button>
            ${replayLink}
          </div>
        </article>
      `
    })
    .join('')

  elements.sessionGrid.querySelectorAll('[data-extend-student]').forEach((button) => {
    button.addEventListener('click', async () => {
      const { hour, minute } = selectedTimeParts(elements.quickExtendTime, 15, 0)
      await extendSelectedAssignmentForStudentToToday(button.dataset.extendStudent, hour, minute)
    })
  })

  elements.sessionGrid.querySelectorAll('[data-open-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await selectReviewSession(button.dataset.openReview)
      } catch (error) {
        window.alert(`Could not switch review sessions: ${error.message}`)
      }
    })
  })

  elements.sessionGrid.querySelectorAll('[data-review-session]').forEach((card) => {
    card.addEventListener('click', async (event) => {
      if (event.target.closest('button, a')) return
      try {
        await selectReviewSession(card.dataset.reviewSession)
      } catch (error) {
        window.alert(`Could not switch review sessions: ${error.message}`)
      }
    })
  })

  if (!selectedReviewSessionId) {
    selectedReviewSessionId = visibleSessions[0]?.id || null
    reviewState = selectedReviewSessionId ? createReviewStateFromSession(currentReviewSession()) : null
  }

  if (!skipReviewWorkspace) {
    renderReviewWorkspace(selectedAssignment)
  }
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
  if (document.activeElement?.closest?.('.review-workspace')) {
    return
  }
  renderView()
}

function renderView() {
  syncSelectionState()
  if (elements.deleteClassroomButton) {
    elements.deleteClassroomButton.disabled = !getSelectedClassroom()
  }
  if (elements.quickExtendButton) {
    elements.quickExtendButton.disabled = !getSelectedAssignment()
  }
  if (elements.quickExtendTime) {
    elements.quickExtendTime.disabled = !getSelectedAssignment()
  }
  if (elements.deleteAssignmentButton) {
    elements.deleteAssignmentButton.disabled = !getSelectedAssignment()
  }

  if (currentView === 'assignment' && selectedAssignmentId) {
    elements.classesView.hidden = true
    elements.assignmentsView.hidden = true
    elements.assignmentView.hidden = false
    renderStudentCards()
  } else if (currentView === 'assignments' && getSelectedClassroom()) {
    elements.classesView.hidden = true
    elements.assignmentsView.hidden = false
    elements.assignmentView.hidden = true
    elements.assignmentStage.hidden = false
    renderAssignmentStage()
  } else {
    elements.classesView.hidden = false
    elements.assignmentsView.hidden = true
    elements.assignmentView.hidden = true
    elements.classroomStage.hidden = false
    renderClassroomGrid()
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

function showAssignmentsView() {
  currentView = getSelectedClassroom() ? 'assignments' : 'classes'
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
  if (form.get('citations_required') === 'on' && form.get('browser_enabled') !== 'on' && !selectedLinkedAssignmentIdsFromForm().length) {
    warnings.push('Citations are required, but there is no study browser or linked reference assignment.')
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

  elements.deleteAssignmentButton?.addEventListener('click', async () => {
    const assignment = getSelectedAssignment()
    if (!assignment) {
      window.alert('Select an assignment first.')
      return
    }
    if (!window.confirm(`Delete ${assignment.title}? Students will no longer see it in Handtyped.`)) {
      return
    }
    try {
      await request(`/api/edu/assignments/${assignment.id}`, { method: 'DELETE' })
      selectedAssignmentId = null
      currentView = getSelectedClassroom() ? 'assignments' : 'classes'
      dashboardState = null
      await refreshDashboard()
      renderView()
    } catch (error) {
      window.alert(`Could not delete assignment: ${error.message}`)
    }
  })

  elements.quickExtendButton?.addEventListener('click', async () => {
    elements.quickExtendButton.disabled = true
    try {
      const time = selectedTimeParts(elements.quickExtendTime)
      await extendSelectedAssignmentToToday(time.hour, time.minute)
    } catch (error) {
      window.alert(`Could not extend access: ${error.message}`)
    } finally {
      elements.quickExtendButton.disabled = !getSelectedAssignment()
    }
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

  document.getElementById('back-to-classes-button')?.addEventListener('click', () => showClassesView())
  document.getElementById('back-to-assignments-button')?.addEventListener('click', () => showAssignmentsView())
  elements.tempAccessTimeButton?.addEventListener('click', () => {
    const time = selectedTimeParts(elements.tempAccessTime)
    setTemporaryAccessToday(time.hour, time.minute)
  })
  elements.assignmentAddStudentOverride?.addEventListener('click', () => {
    assignmentStudentOverrideDrafts = [...currentStudentOverrideDrafts(), createStudentOverrideDraft()]
    renderStudentOverrideCards(assignmentStudentOverrideDrafts)
  })
  elements.assignmentAddRubric?.addEventListener('click', () => {
    renderRubricBuilder([...selectedRubricFromForm(), createRubricDraft({ title: '', points: 4 })])
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
  elements.assignmentForm.elements.namedItem('editor_font_family').value = 'arial'
  elements.assignmentForm.elements.namedItem('editor_font_size').value = '22'
  elements.assignmentForm.elements.namedItem('editor_line_height').value = 'relaxed'
  elements.assignmentCourseSelect.disabled = false
  populateAssignmentCourseSelect()
  if (elements.assignmentAssignedExtra) {
    elements.assignmentAssignedExtra.value = ''
  }
  assignmentStudentOverrideDrafts = []
  renderAssignedStudentOptions([])
  renderStudentOverrideCards([])
  renderLinkedAssignmentOptions([])
  renderRubricBuilder([])
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
    form.allow_dictation.checked = assignment.policy.allow_dictation ?? false
    form.copy_paste_allowed.checked = assignment.policy.copy_paste_allowed ?? false
    form.printing_allowed.checked = assignment.policy.printing_allowed ?? false
    form.export_allowed.checked = assignment.policy.export_allowed ?? false
    form.images_allowed.checked = assignment.policy.images_allowed ?? false
    form.citations_required.checked = assignment.policy.citations_required ?? false
    form.require_lockdown.checked = assignment.policy.require_lockdown ?? false
    form.require_fullscreen.checked = assignment.policy.require_fullscreen ?? false
  }

  if (assignment.editor_policy) {
    form.editor_font_family.value = assignment.editor_policy.font_family || 'arial'
    form.editor_font_size.value = String(assignment.editor_policy.font_size ?? 22)
    form.editor_line_height.value = assignment.editor_policy.line_height || 'relaxed'
  }

  if (assignment.browser_policy) {
    form.browser_enabled.checked = assignment.browser_policy.browser_enabled ?? false
    form.browser_home_url.value = assignment.browser_policy.home_url || ''
    form.browser_allowed_domains.value = (assignment.browser_policy.allowed_domains || []).join('\n')
  }
  const knownStudents = new Set(knownStudentsForClassroom(assignment.classroom_id || selectedClassroomId || ''))
  const assignedStudents = Array.isArray(assignment.assigned_students) ? assignment.assigned_students : []
  form.assigned_students_extra.value = assignedStudents.filter((name) => !knownStudents.has(name)).join('\n')
  renderAssignedStudentOptions(assignedStudents)
  renderStudentOverrideCards(draftsFromAssignmentStudentOverrides(assignment))
  renderLinkedAssignmentOptions(assignment.linked_assignment_ids || [])
  renderRubricBuilder(assignment.rubric || [])
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
  elements.assignmentCourseSelect?.addEventListener('change', () => {
    renderAssignedStudentOptions()
    renderStudentOverrideCards(currentStudentOverrideDrafts())
    renderLinkedAssignmentOptions()
  })

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
      const studentOverrides = selectedStudentOverridesFromForm()

      if (!isEditing && !activeClassroom) {
        window.alert('Choose a class first before creating an assignment.')
        return
      }

      const payload = {
        title: form.get('title'),
        course: activeClassroom ? activeClassroom.name : getSelectedClassroom()?.name || '',
        classroom_id: isEditing ? undefined : activeClassroom?.id,
        classroom_name: isEditing ? undefined : activeClassroom?.name,
        assigned_students: selectedAssignedStudentsFromForm(),
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
        student_temporary_access_until: studentOverrides.studentTemporaryAccessUntil,
        policy: {
          allow_dictation: form.get('allow_dictation') === 'on',
          copy_paste_allowed: form.get('copy_paste_allowed') === 'on',
          printing_allowed: form.get('printing_allowed') === 'on',
          export_allowed: form.get('export_allowed') === 'on',
          images_allowed: form.get('images_allowed') === 'on',
          citations_required: form.get('citations_required') === 'on',
          require_lockdown: form.get('require_lockdown') === 'on',
          require_fullscreen: form.get('require_fullscreen') === 'on',
        },
        editor_policy: {
          font_family: String(form.get('editor_font_family') || 'serif'),
          font_size: Number(form.get('editor_font_size') || 22),
          line_height: String(form.get('editor_line_height') || 'relaxed'),
        },
        browser_policy: {
          browser_enabled: form.get('browser_enabled') === 'on',
          home_url: form.get('browser_home_url') || '',
          allowed_domains: String(form.get('browser_allowed_domains') || '')
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
        student_overrides: studentOverrides.studentOverrides,
        linked_assignment_ids: [...new Set(form.getAll('linked_assignment_ids').map((value) => String(value).trim()).filter(Boolean))],
        rubric: selectedRubricFromForm(),
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

function wireReviewWorkspace() {
  elements.reviewGradeLabel?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.gradeLabel = elements.reviewGradeLabel.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewGradeScore?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.gradeScore = elements.reviewGradeScore.value
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewTeacherComment?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.teacherComment = elements.reviewTeacherComment.value
    markReviewDirty()
  })

  elements.reviewSuggestedRevisions?.addEventListener('input', () => {
    if (!reviewState) return
    reviewState.suggestedRevisions = elements.reviewSuggestedRevisions.value
    markReviewDirty()
  })

  elements.reviewReturned?.addEventListener('change', () => {
    if (!reviewState) return
    reviewState.returnedForRevision = elements.reviewReturned.checked
    markReviewDirty()
    renderStudentCards({ skipReviewWorkspace: true })
  })

  elements.reviewDraftSurface?.addEventListener('mouseup', handleReviewDraftSelection)
  elements.reviewDraftSurface?.addEventListener('keyup', handleReviewDraftSelection)

  elements.reviewCommentMode?.addEventListener('click', () => beginReviewComposer('comment'))
  elements.reviewSuggestMode?.addEventListener('click', () => beginReviewComposer('suggestion'))
  elements.reviewCancelAnnotation?.addEventListener('click', clearReviewComposer)
  elements.reviewAddAnnotation?.addEventListener('click', addReviewAnnotation)

  window.addEventListener('beforeunload', () => {
    if (reviewSaveTimer) {
      clearTimeout(reviewSaveTimer)
      reviewSaveTimer = null
    }
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
  wireReviewWorkspace()
  await refreshDashboard()
  startDashboardRefresh()
}

loadApp().catch((error) => {
  document.body.innerHTML = `<div style="padding:32px;font-family:'Open Sans', Arial, Helvetica, sans-serif">Could not load Handtyped EDU: ${escapeHtml(error.message)}</div>`
})
