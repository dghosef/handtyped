import { buildTeacherPasswordFields } from './edu-password.js'

function randomId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }

  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${hex}`
}

export function normalizeTeacherEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function nowIso() {
  return new Date().toISOString()
}

function normalizeStudentOverrideKey(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeStudentPolicyOverride(input = {}) {
  const output = {}
  for (const key of [
    'allow_dictation',
    'allow_offline_editing',
    'copy_paste_allowed',
    'printing_allowed',
    'export_allowed',
    'images_allowed',
    'citations_required',
    'require_lockdown',
    'require_fullscreen',
  ]) {
    if (typeof input?.[key] === 'boolean') {
      output[key] = input[key]
    }
  }
  return output
}

function normalizeStudentEditorOverride(input = {}) {
  const output = {}
  if (['arial', 'serif', 'sans', 'mono'].includes(input?.font_family)) {
    output.font_family = input.font_family
  }
  if ([16, 18, 20, 22, 24, 28, 32].includes(Number(input?.font_size))) {
    output.font_size = Number(input.font_size)
  }
  if (['compact', 'single', 'relaxed', 'one-half', 'double'].includes(input?.line_height)) {
    output.line_height = input.line_height
  }
  return output
}

function normalizeStudentBrowserOverride(input = {}) {
  const output = {}
  if (typeof input?.browser_enabled === 'boolean') {
    output.browser_enabled = input.browser_enabled
  }
  if (Object.hasOwn(input || {}, 'home_url')) {
    output.home_url = String(input?.home_url || '')
  }
  if (Object.hasOwn(input || {}, 'allowed_domains')) {
    output.allowed_domains = Array.isArray(input?.allowed_domains)
      ? input.allowed_domains.map((value) => String(value || '').trim()).filter(Boolean)
      : []
  }
  if (typeof input?.log_all_navigation === 'boolean') {
    output.log_all_navigation = input.log_all_navigation
  }
  return output
}

function normalizeStudentOverrides(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }

  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
      continue
    }
    const studentName = String(rawValue.student_name || rawKey || '').trim()
    const key = normalizeStudentOverrideKey(studentName || rawKey)
    if (!key) {
      continue
    }

    const policy = normalizeStudentPolicyOverride(rawValue.policy)
    const editorPolicy = normalizeStudentEditorOverride(rawValue.editor_policy)
    const browserPolicy = normalizeStudentBrowserOverride(rawValue.browser_policy)
    const override = {
      student_name: studentName || rawKey,
    }

    if (Object.keys(policy).length) {
      override.policy = policy
    }
    if (Object.keys(editorPolicy).length) {
      override.editor_policy = editorPolicy
    }
    if (Object.keys(browserPolicy).length) {
      override.browser_policy = browserPolicy
    }

    if (Object.hasOwn(rawValue, 'temporary_access_until')) {
      override.temporary_access_until = rawValue.temporary_access_until ?? null
    }

    if (
      override.policy ||
      override.editor_policy ||
      override.browser_policy ||
      Object.hasOwn(override, 'temporary_access_until')
    ) {
      normalized[key] = override
    }
  }

  return normalized
}

export function buildClassroom(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('classroom'),
    name: String(input.name || 'Untitled classroom'),
    join_code: String(input.join_code || 'JOINME').toUpperCase(),
    teacher_name: String(input.teacher_name || 'Teacher'),
    students: Array.isArray(input.students) ? input.students : [],
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildTeacher(input = {}) {
  const now = nowIso()
  const passwordFields = buildTeacherPasswordFields(input)
  return {
    id: input.id || randomId('teacher'),
    name: String(input.name || 'Teacher'),
    email: normalizeTeacherEmail(input.email || 'teacher@edu.handtyped.app'),
    access_code: String(input.access_code || 'handtyped-edu'),
    password_hash: passwordFields.password_hash,
    password_salt: passwordFields.password_salt,
    google_subject: input.google_subject ? String(input.google_subject) : null,
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildAssignmentWindow(input = {}) {
  return {
    label: String(input.label || 'Writing window'),
    days: input.days || {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
    },
    end_date: input.end_date ?? null,
    start_hour: Number(input.start_hour ?? 10),
    start_minute: Number(input.start_minute ?? 0),
    end_hour: Number(input.end_hour ?? 11),
    end_minute: Number(input.end_minute ?? 0),
  }
}

export function buildRubricCriterion(input = {}) {
  return {
    id: input.id || randomId('rubric'),
    title: String(input.title || 'Criterion'),
    description: String(input.description || ''),
    points: Math.max(1, Number(input.points || 4)),
  }
}

export function buildAssignment(input = {}) {
  const now = nowIso()
  const linkedAssignmentIds = Array.isArray(input.linked_assignment_ids)
    ? [...new Set(input.linked_assignment_ids.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  const assignedStudents = Array.isArray(input.assigned_students)
    ? [...new Set(input.assigned_students.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  return {
    id: input.id || randomId('assignment'),
    title: String(input.title || 'Untitled assignment'),
    course: String(input.course || 'English'),
    classroom_id: input.classroom_id ?? null,
    classroom_name: input.classroom_name ?? null,
    prompt: String(input.prompt || ''),
    instructions: String(input.instructions || ''),
    starter_document: String(input.starter_document || ''),
    windows: Array.isArray(input.windows)
      ? input.windows.map(buildAssignmentWindow)
      : [buildAssignmentWindow()],
    policy: {
      allow_dictation: Boolean(input.policy?.allow_dictation),
      allow_offline_editing: input.policy?.allow_offline_editing ?? true,
      copy_paste_allowed: Boolean(input.policy?.copy_paste_allowed),
      printing_allowed: Boolean(input.policy?.printing_allowed),
      export_allowed: Boolean(input.policy?.export_allowed),
      images_allowed: Boolean(input.policy?.images_allowed),
      citations_required: Boolean(input.policy?.citations_required),
      require_lockdown: input.policy?.require_lockdown ?? true,
      require_fullscreen: input.policy?.require_fullscreen ?? false,
    },
    editor_policy: {
      font_family: ['arial', 'serif', 'sans', 'mono'].includes(input.editor_policy?.font_family)
        ? input.editor_policy.font_family
        : 'arial',
      font_size: [16, 18, 20, 22, 24, 28, 32].includes(Number(input.editor_policy?.font_size))
        ? Number(input.editor_policy.font_size)
        : 22,
      line_height: ['compact', 'single', 'relaxed', 'one-half', 'double'].includes(input.editor_policy?.line_height)
        ? input.editor_policy.line_height
        : 'relaxed',
    },
    browser_policy: {
      browser_enabled: input.browser_policy?.browser_enabled ?? true,
      home_url: String(input.browser_policy?.home_url || 'https://www.gutenberg.org'),
      allowed_domains: Array.isArray(input.browser_policy?.allowed_domains)
        ? input.browser_policy.allowed_domains
        : ['gutenberg.org'],
      log_all_navigation: input.browser_policy?.log_all_navigation ?? true,
    },
    assigned_students: assignedStudents,
    linked_assignment_ids: linkedAssignmentIds,
    rubric: Array.isArray(input.rubric)
      ? input.rubric.map(buildRubricCriterion).filter((criterion) => criterion.title.trim())
      : [],
    temporary_access_until: input.temporary_access_until ?? null,
    student_temporary_access_until:
      input.student_temporary_access_until && typeof input.student_temporary_access_until === 'object'
        ? { ...input.student_temporary_access_until }
        : {},
    student_overrides: normalizeStudentOverrides(input.student_overrides),
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

function normalizeGradeScore(value) {
  if (value === '' || value == null) {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeInlineAnnotation(input = {}) {
  const createdAt = String(input.created_at || nowIso())
  const start = Math.max(0, Number(input.start ?? 0) || 0)
  const end = Math.max(start, Number(input.end ?? start) || start)
  const type = input.type === 'suggestion' ? 'suggestion' : 'comment'
  return {
    id: input.id || randomId('annotation'),
    type,
    start,
    end,
    quote: String(input.quote || ''),
    note: String(input.note || ''),
    replacement: type === 'suggestion' ? String(input.replacement || '') : '',
    created_at: createdAt,
    updated_at: String(input.updated_at || createdAt),
  }
}

export function buildLiveSession(input = {}) {
  return {
    id: input.id || randomId('live'),
    assignment_id: String(input.assignment_id || ''),
    assignment_title: String(input.assignment_title || ''),
    course: String(input.course || ''),
    classroom: input.classroom ?? null,
    student_name: String(input.student_name || 'Student'),
    current_text: String(input.current_text || ''),
    document_history: Array.isArray(input.document_history) ? input.document_history : [],
    focus_events: Array.isArray(input.focus_events) ? input.focus_events : [],
    keystroke_log: String(input.keystroke_log || ''),
    current_url: input.current_url ?? null,
    current_url_title: input.current_url_title ?? null,
    url_history: Array.isArray(input.url_history) ? input.url_history : [],
    violation_count: Number(input.violation_count ?? 0),
    violations: Array.isArray(input.violations) ? input.violations : [],
    last_activity_at: String(input.last_activity_at || nowIso()),
    schedule_open: input.schedule_open ?? true,
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    replay_session_id: input.replay_session_id ?? null,
    grading:
      input.grading && typeof input.grading === 'object'
        ? {
            rubric_scores:
              input.grading.rubric_scores && typeof input.grading.rubric_scores === 'object'
                ? { ...input.grading.rubric_scores }
                : {},
            teacher_comment: String(input.grading.teacher_comment || ''),
            suggested_revisions: String(input.grading.suggested_revisions || ''),
            returned_for_revision: Boolean(input.grading.returned_for_revision),
            grade_label: String(input.grading.grade_label || ''),
            grade_score: normalizeGradeScore(input.grading.grade_score),
            inline_annotations: Array.isArray(input.grading.inline_annotations)
              ? input.grading.inline_annotations
                  .map(normalizeInlineAnnotation)
                  .sort((a, b) => a.start - b.start || a.end - b.end)
              : [],
            updated_at: input.grading.updated_at || null,
            actor_id: input.grading.actor_id ?? null,
            actor_name: input.grading.actor_name ?? null,
            actor_email: input.grading.actor_email ?? null,
          }
        : {
            rubric_scores: {},
            teacher_comment: '',
            suggested_revisions: '',
            returned_for_revision: false,
            grade_label: '',
            grade_score: null,
            inline_annotations: [],
            updated_at: null,
            actor_id: null,
            actor_name: null,
            actor_email: null,
          },
    updated_at: String(input.updated_at || nowIso()),
  }
}

export function buildAssignmentAudit(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('assignment_audit'),
    assignment_id: String(input.assignment_id || ''),
    classroom_id: input.classroom_id ?? null,
    assignment_title: String(input.assignment_title || ''),
    action: String(input.action || 'updated'),
    actor_id: input.actor_id ?? null,
    actor_name: input.actor_name ?? null,
    actor_email: input.actor_email ?? null,
    summary: String(input.summary || ''),
    changes: Array.isArray(input.changes) ? input.changes : [],
    snapshot: input.snapshot || null,
    created_at: String(input.created_at || now),
    updated_at: String(input.updated_at || now),
  }
}

export function buildEduReplay(input = {}) {
  return {
    id: input.id || randomId('edu_replay'),
    live_session_id: String(input.live_session_id || ''),
    assignment_id: String(input.assignment_id || ''),
    assignment_title: String(input.assignment_title || ''),
    course: String(input.course || ''),
    classroom: input.classroom ?? null,
    student_name: String(input.student_name || 'Student'),
    current_text: String(input.current_text || ''),
    document_history: Array.isArray(input.document_history) ? input.document_history : [],
    keystroke_log: String(input.keystroke_log || ''),
    focus_events: Array.isArray(input.focus_events) ? input.focus_events : [],
    current_url: input.current_url ?? null,
    current_url_title: input.current_url_title ?? null,
    url_history: Array.isArray(input.url_history) ? input.url_history : [],
    violation_count: Number(input.violation_count ?? 0),
    violations: Array.isArray(input.violations) ? input.violations : [],
    last_activity_at: String(input.last_activity_at || nowIso()),
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    start_wall_ns: Number(input.start_wall_ns || 0),
    updated_at: String(input.updated_at || nowIso()),
  }
}

export function buildTeacherSessionRecord(input = {}) {
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  return {
    id: input.id || randomId('teacher_session'),
    teacher_id: String(input.teacher_id || ''),
    teacher_name: String(input.teacher_name || 'Teacher'),
    teacher_email: normalizeTeacherEmail(input.teacher_email || ''),
    provider: String(input.provider || 'access-code'),
    created_at: input.created_at || now,
    expires_at: input.expires_at || expiresAt,
  }
}

export function buildTeacherAuthSession(input = {}) {
  return {
    authenticated: Boolean(input.authenticated),
    teacher_id: input.teacher_id ?? null,
    teacher_name: input.teacher_name ?? null,
    teacher_email: input.teacher_email ?? null,
    provider: input.provider || 'access-code',
  }
}
