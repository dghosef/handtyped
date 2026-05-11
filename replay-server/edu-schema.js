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

export const DEFAULT_TENANT_ID = 'tenant_demo'
const LIVE_SESSION_SUMMARY_HISTORY_LIMIT = 1000

export const EDU_EDITOR_FONT_FAMILIES = Object.freeze([
  'arial',
  'serif',
  'sans',
  'mono',
  'georgia',
  'times',
  'garamond',
  'palatino',
  'baskerville',
  'verdana',
  'trebuchet',
  'tahoma',
  'helvetica',
  'courier',
  'comic-sans',
  'lucida',
])

function normalizeStudentOverrideKey(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeStudentAccessRequest(input = {}, fallbackKey = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const student_name = String(input.student_name || fallbackKey || '').trim()
  const key = normalizeStudentOverrideKey(student_name || fallbackKey)
  if (!key) {
    return null
  }
  return {
    student_name: student_name || fallbackKey,
    requested_at: String(input.requested_at || nowIso()),
    note: String(input.note || ''),
  }
}

function normalizeStudentAccessRequests(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const request = normalizeStudentAccessRequest(rawValue, rawKey)
    if (request) {
      normalized[normalizeStudentOverrideKey(request.student_name)] = request
    }
  }
  return normalized
}

function normalizeStudentIsoMap(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [normalizeStudentOverrideKey(key), value ? String(value) : null])
      .filter(([key, value]) => key && value),
  )
}

function normalizeStudentFeedbackRequest(input = {}, fallbackKey = '') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const student_name = String(input.student_name || fallbackKey || '').trim()
  const key = normalizeStudentOverrideKey(student_name || fallbackKey)
  if (!key) {
    return null
  }
  return {
    student_name: student_name || fallbackKey,
    requested_at: String(input.requested_at || nowIso()),
    note: String(input.note || ''),
  }
}

function normalizeStudentFeedbackRequests(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  const normalized = {}
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const request = normalizeStudentFeedbackRequest(rawValue, rawKey)
    if (request) {
      normalized[normalizeStudentOverrideKey(request.student_name)] = request
    }
  }
  return normalized
}

function normalizeStudentPolicyOverride(input = {}) {
  const output = {}
  for (const key of [
    'allow_dictation',
    'allow_offline_editing',
    'copy_paste_allowed',
    'export_allowed',
    'images_allowed',
    'require_lockdown',
    'require_permission_to_rejoin',
    'require_fullscreen',
    'show_rubric_to_student',
  ]) {
    if (typeof input?.[key] === 'boolean') {
      output[key] = input[key]
    }
  }
  return output
}

function normalizeStudentEditorOverride(input = {}) {
  const output = {}
  if (EDU_EDITOR_FONT_FAMILIES.includes(input?.font_family)) {
    output.font_family = input.font_family
  }
  if (Number(input?.font_size) >= 10 && Number(input?.font_size) <= 100) {
    output.font_size = Number(input.font_size)
  }
  if (['compact', 'single', 'relaxed', 'one-half', 'double'].includes(input?.line_height)) {
    output.line_height = input.line_height
  }
  if (typeof input?.font_locked === 'boolean') {
    output.font_locked = input.font_locked
  }
  return output
}

function isLegacyDefaultEditorPolicy(input = {}) {
  return input?.font_family === 'arial'
    && Number(input?.font_size ?? 12) === 12
    && input?.line_height === 'relaxed'
    && !input?.font_locked
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
  if (input?.mode === 'blacklist' || input?.mode === 'whitelist') {
    output.mode = input.mode
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

function normalizeStudentFeedback(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }

  const rubric_scores =
    input.rubric_scores && typeof input.rubric_scores === 'object' ? { ...input.rubric_scores } : {}
  const inline_annotations = Array.isArray(input.inline_annotations)
    ? input.inline_annotations
        .map(normalizeInlineAnnotation)
        .sort((a, b) => a.start - b.start || a.end - b.end)
    : []
  const teacher_comment = String(input.teacher_comment || '')
  const returned_for_revision = Boolean(input.returned_for_revision)
  const grade_label = String(input.grade_label || '')
  const grade_score = input.grade_score == null ? '' : String(input.grade_score)
  const updated_at = input.updated_at || null
  const actor_name = input.actor_name || null
  const actor_email = input.actor_email || null

  const hasVisibleContent =
    Object.keys(rubric_scores).length > 0 ||
    inline_annotations.length > 0 ||
    teacher_comment ||
    returned_for_revision ||
    grade_label ||
    grade_score

  if (!hasVisibleContent) {
    return null
  }

  return {
    rubric_scores,
    teacher_comment,
    returned_for_revision,
    grade_label,
    grade_score,
    inline_annotations,
    updated_at,
    actor_name,
    actor_email,
  }
}

export function buildClassroom(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('classroom'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
    name: String(input.name || 'Untitled classroom'),
    join_code: String(input.join_code || 'JOINME').toUpperCase(),
    teacher_name: String(input.teacher_name || 'Teacher'),
    students: Array.isArray(input.students) ? input.students : [],
    removed_students: Array.isArray(input.removed_students) ? input.removed_students : [],
    student_aliases:
      input.student_aliases && typeof input.student_aliases === 'object' && !Array.isArray(input.student_aliases)
        ? { ...input.student_aliases }
        : {},
    created_at: input.created_at || now,
    updated_at: input.updated_at || now,
  }
}

export function buildTeacher(input = {}) {
  const now = nowIso()
  const passwordFields = buildTeacherPasswordFields(input)
  return {
    id: input.id || randomId('teacher'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
    name: String(input.name || 'Teacher'),
    email: normalizeTeacherEmail(input.email || ''),
    access_code: String(input.access_code || ''),
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

function normalizeReferenceDocuments(input) {
  if (!Array.isArray(input)) {
    return []
  }
  return input
    .map((item = {}) => {
      const dataUrl = String(item.data_url || '').trim()
      if (!/^data:application\/pdf(?:;[^,]*)?,/i.test(dataUrl)) {
        return null
      }
      return {
        id: item.id || randomId('refdoc'),
        title: String(item.title || 'Reference PDF').trim() || 'Reference PDF',
        mime_type: 'application/pdf',
        data_url: dataUrl,
        size_bytes: Math.max(0, Number(item.size_bytes || 0)),
      }
    })
    .filter(Boolean)
}

export function buildAssignment(input = {}) {
  const now = nowIso()
  const linkedAssignmentIds = Array.isArray(input.linked_assignment_ids)
    ? [...new Set(input.linked_assignment_ids.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  const assignedStudents = Array.isArray(input.assigned_students)
    ? [...new Set(input.assigned_students.map((value) => String(value || '').trim()).filter(Boolean))]
    : []
  const legacyDefaultEditorPolicy = isLegacyDefaultEditorPolicy(input.editor_policy)
  return {
    id: input.id || randomId('assignment'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
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
      export_allowed: Boolean(input.policy?.export_allowed),
      images_allowed: Boolean(input.policy?.images_allowed),
      require_lockdown: input.policy?.require_lockdown ?? true,
      require_permission_to_rejoin: Boolean(input.policy?.require_permission_to_rejoin),
      require_fullscreen: input.policy?.require_fullscreen ?? false,
      show_rubric_to_student: Boolean(input.policy?.show_rubric_to_student),
    },
    editor_policy: {
      font_family: legacyDefaultEditorPolicy
        ? 'times'
        : EDU_EDITOR_FONT_FAMILIES.includes(input.editor_policy?.font_family)
        ? input.editor_policy.font_family
        : 'times',
      font_size:
        Number(input.editor_policy?.font_size) >= 10 && Number(input.editor_policy?.font_size) <= 100
        ? Number(input.editor_policy.font_size)
        : 12,
      line_height: legacyDefaultEditorPolicy
        ? 'double'
        : ['compact', 'single', 'relaxed', 'one-half', 'double'].includes(input.editor_policy?.line_height)
        ? input.editor_policy.line_height
        : 'double',
      font_locked: Boolean(input.editor_policy?.font_locked),
    },
    browser_policy: {
      browser_enabled: input.browser_policy?.browser_enabled ?? true,
      home_url: String(input.browser_policy?.home_url || ''),
      mode: input.browser_policy?.mode === 'blacklist' ? 'blacklist' : 'whitelist',
      allowed_domains: Array.isArray(input.browser_policy?.allowed_domains)
        ? input.browser_policy.allowed_domains
        : [],
      log_all_navigation: input.browser_policy?.log_all_navigation ?? true,
    },
    assigned_students: assignedStudents,
    linked_assignment_ids: linkedAssignmentIds,
    reference_documents: normalizeReferenceDocuments(input.reference_documents),
    rubric: Array.isArray(input.rubric)
      ? input.rubric.map(buildRubricCriterion).filter((criterion) => criterion.title.trim())
      : [],
    student_feedback: normalizeStudentFeedback(input.student_feedback),
    student_access_requests: normalizeStudentAccessRequests(input.student_access_requests),
    student_feedback_requests: normalizeStudentFeedbackRequests(input.student_feedback_requests),
    temporary_access_until: input.temporary_access_until ?? null,
    student_temporary_access_until:
      input.student_temporary_access_until && typeof input.student_temporary_access_until === 'object'
        ? { ...input.student_temporary_access_until }
        : {},
    student_access_revoked:
      input.student_access_revoked && typeof input.student_access_revoked === 'object'
        ? Object.fromEntries(
            Object.entries(input.student_access_revoked)
              .map(([key, value]) => [normalizeStudentOverrideKey(key), Boolean(value)])
              .filter(([, value]) => value),
          )
        : {},
    student_access_revoked_until: normalizeStudentIsoMap(input.student_access_revoked_until),
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
  const originalStart = Math.max(0, Number(input.original_start ?? start) || 0)
  const originalEnd = Math.max(originalStart, Number(input.original_end ?? end) || end)
  return {
    id: input.id || randomId('annotation'),
    type,
    start,
    end,
    original_start: originalStart,
    original_end: originalEnd,
    quote: String(input.quote || ''),
    note: String(input.note || ''),
    replacement: type === 'suggestion' ? String(input.replacement || '') : '',
    context_before: String(input.context_before || ''),
    context_after: String(input.context_after || ''),
    created_at: createdAt,
    updated_at: String(input.updated_at || createdAt),
    resolved_by_student: Boolean(input.resolved_by_student),
    resolved_at: input.resolved_at || null,
    resolved_by: input.resolved_by || null,
  }
}

export function buildLiveSession(input = {}) {
  return {
    id: input.id || randomId('live'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
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
            returned_for_revision: Boolean(input.grading.returned_for_revision),
            grade_label: String(input.grading.grade_label || ''),
            grade_score: normalizeGradeScore(input.grading.grade_score),
            inline_annotations: Array.isArray(input.grading.inline_annotations)
              ? input.grading.inline_annotations
                  .map(normalizeInlineAnnotation)
                  .sort((a, b) => a.start - b.start || a.end - b.end)
              : [],
            updated_at: input.grading.updated_at || null,
            feedback_status: input.grading.feedback_status === 'draft' ? 'draft' : 'published',
            published_at: input.grading.published_at || null,
            actor_id: input.grading.actor_id ?? null,
            actor_name: input.grading.actor_name ?? null,
            actor_email: input.grading.actor_email ?? null,
          }
        : {
            rubric_scores: {},
            teacher_comment: '',
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

export function normalizeDocHistoryEntry(input = {}) {
  const t = Number(input?.t)
  const pos = Number(input?.pos)
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(pos) || pos < 0) {
    return null
  }
  if (typeof input?.del !== 'string' || typeof input?.ins !== 'string') {
    return null
  }
  const normalized = {
    t,
    pos: Math.floor(pos),
    del: input.del,
    ins: input.ins,
  }
  const absoluteWallMs = Number(input?.absolute_wall_ms)
  if (Number.isFinite(absoluteWallMs) && absoluteWallMs > 0) {
    normalized.absolute_wall_ms = Math.floor(absoluteWallMs)
  }
  return normalized
}

export function docHistoryLatestT(history = []) {
  return Array.isArray(history)
    ? history.reduce((latest, entry) => {
        const t = Number(entry?.t)
        return Number.isFinite(t) && t > latest ? t : latest
      }, 0)
    : 0
}

export function applyDocHistoryEntry(text = '', entry = {}) {
  const normalized = normalizeDocHistoryEntry(entry)
  if (!normalized) {
    throw new Error('Invalid document history entry')
  }
  const chars = Array.from(String(text || ''))
  const delChars = Array.from(normalized.del)
  const pos = Math.max(0, Math.min(normalized.pos, chars.length))
  const actualDeleted = chars.slice(pos, pos + delChars.length).join('')
  if (actualDeleted !== normalized.del) {
    throw new Error('Document history entry does not match current text')
  }
  chars.splice(pos, delChars.length, ...Array.from(normalized.ins))
  return chars.join('')
}

export function applyDocHistoryTail(text = '', entries = []) {
  return entries.reduce((nextText, entry) => applyDocHistoryEntry(nextText, entry), String(text || ''))
}

export function liveSessionHistoryAck(session = {}, { needsCheckpoint = false, usedCheckpoint = false } = {}) {
  const history = Array.isArray(session?.document_history) ? session.document_history : []
  return {
    accepted_history_count: history.length,
    latest_history_t: docHistoryLatestT(history),
    needs_checkpoint: Boolean(needsCheckpoint),
    used_checkpoint: Boolean(usedCheckpoint),
  }
}

export function mergeLiveSessionDraft(input = {}, existing = {}) {
  const existingHistory = Array.isArray(existing?.document_history) ? existing.document_history : []
  const existingText = String(existing?.current_text || '')
  const incomingCheckpoint = Object.hasOwn(input || {}, 'current_text_checkpoint')
    ? String(input?.current_text_checkpoint || '')
    : null
  const incomingTail = Array.isArray(input?.document_history_tail)
    ? input.document_history_tail.map(normalizeDocHistoryEntry).filter(Boolean)
    : null
  const hasTailContract =
    incomingTail != null ||
    Object.hasOwn(input || {}, 'history_base_count') ||
    Object.hasOwn(input || {}, 'history_base_t') ||
    incomingCheckpoint != null

  if (!hasTailContract) {
    const incomingCurrentText = Object.hasOwn(input || {}, 'current_text')
      ? String(input?.current_text || '')
      : null
    const incomingHistory = Array.isArray(input?.document_history) ? input.document_history : null
    const session = {
      current_text:
        incomingCurrentText != null
          ? incomingCurrentText || existingText
          : existingText || input?.current_text || '',
      document_history:
        incomingHistory != null
          ? incomingHistory.length
            ? incomingHistory
            : existingHistory
          : existingHistory.length
            ? existingHistory
            : input?.document_history || [],
    }
    return { session, ack: liveSessionHistoryAck(session) }
  }

  const baseCount = Math.max(0, Number(input?.history_base_count ?? 0) || 0)
  const baseT = Math.max(0, Number(input?.history_base_t ?? 0) || 0)
  const existingLatestT = docHistoryLatestT(existingHistory)
  const baseMatches = baseCount === existingHistory.length && baseT === existingLatestT
  const usedCheckpoint = incomingCheckpoint != null

  if (!baseMatches && !usedCheckpoint && incomingTail?.length) {
    return {
      error: {
        status: 409,
        body: {
          error: 'checkpoint_required',
          ...liveSessionHistoryAck(existing, { needsCheckpoint: true }),
        },
      },
    }
  }

  let documentHistory = existingHistory.slice()
  const appendableTail = baseMatches
    ? incomingTail || []
    : (incomingTail || []).filter((entry) => Number(entry.t) > existingLatestT)
  const incomingCurrentText = Object.hasOwn(input || {}, 'current_text')
    ? String(input?.current_text || '')
    : null
  let currentText = usedCheckpoint
    ? incomingCheckpoint || (appendableTail.length ? incomingCheckpoint : existingText)
    : appendableTail.length
      ? existingText
      : incomingCurrentText ?? existingText

  if (!usedCheckpoint && appendableTail.length) {
    try {
      currentText = applyDocHistoryTail(currentText, appendableTail)
    } catch {
      return {
        error: {
          status: 409,
          body: {
            error: 'checkpoint_required',
            ...liveSessionHistoryAck(existing, { needsCheckpoint: true }),
          },
        },
      }
    }
  }

  if (appendableTail.length) {
    documentHistory = documentHistory.concat(appendableTail)
  }

  const session = {
    current_text: currentText,
    document_history: documentHistory,
  }
  return {
    session,
    ack: liveSessionHistoryAck(session, { usedCheckpoint }),
  }
}

export function buildLiveSessionSummary(input = {}) {
  const session = buildLiveSession(input)
  const recentEditCount = Number.isFinite(Number(input?.recent_edit_count))
    ? Math.max(0, Number(input.recent_edit_count))
    : Array.isArray(session.document_history)
      ? Math.min(25, session.document_history.length)
      : 0
  const documentHistory = Array.isArray(session.document_history)
    ? session.document_history.slice(-LIVE_SESSION_SUMMARY_HISTORY_LIMIT)
    : []
  return {
    id: session.id,
    tenant_id: session.tenant_id,
    assignment_id: session.assignment_id,
    assignment_title: session.assignment_title,
    course: session.course,
    classroom: session.classroom,
    student_name: session.student_name,
    current_text: session.current_text,
    current_url: session.current_url,
    current_url_title: session.current_url_title,
    url_history: Array.isArray(session.url_history) ? session.url_history.slice(-4) : [],
    violation_count: session.violation_count,
    violations: Array.isArray(session.violations) ? session.violations.slice(-4) : [],
    focus_events: Array.isArray(session.focus_events) ? session.focus_events.slice(-8) : [],
    document_history: documentHistory,
    recent_edit_count: recentEditCount,
    last_activity_at: session.last_activity_at,
    schedule_open: session.schedule_open,
    focused: session.focused,
    hid_active: session.hid_active,
    replay_session_id: session.replay_session_id,
    grading: session.grading,
    updated_at: session.updated_at,
  }
}

export function buildLiveReplayHead(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('live_replay'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
    live_session_id: String(input.live_session_id || input.id || ''),
    replay_session_id: input.replay_session_id ?? null,
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
    last_activity_at: String(input.last_activity_at || now),
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    start_wall_ns: Number(input.start_wall_ns || 0),
    replay_origin_wall_ms:
      input.replay_origin_wall_ms == null ? null : Number(input.replay_origin_wall_ms || 0),
    recorded_timezone_offset_minutes:
      input.recorded_timezone_offset_minutes == null ? null : Number(input.recorded_timezone_offset_minutes || 0),
    recorded_timezone: input.recorded_timezone ? String(input.recorded_timezone) : null,
    snapshot_history_count: Math.max(
      0,
      Number(
        input.snapshot_history_count ??
          (Array.isArray(input.document_history) ? input.document_history.length : 0),
      ) || 0,
    ),
    snapshot_url_history_count: Math.max(
      0,
      Number(
        input.snapshot_url_history_count ??
          (Array.isArray(input.url_history) ? input.url_history.length : 0),
      ) || 0,
    ),
    last_event_seq: Math.max(0, Number(input.last_event_seq ?? 0) || 0),
    created_at: String(input.created_at || now),
    updated_at: String(input.updated_at || now),
  }
}

export function buildLiveReplayEvent(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('live_replay_event'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
    live_session_id: String(input.live_session_id || ''),
    replay_session_id: input.replay_session_id ?? null,
    assignment_id: String(input.assignment_id || ''),
    student_name: String(input.student_name || 'Student'),
    seq: Math.max(1, Number(input.seq ?? 1) || 1),
    ...(Object.hasOwn(input, 'current_text') ? { current_text: String(input.current_text || '') } : {}),
    ...(Number.isFinite(Number(input.current_text_length))
      ? { current_text_length: Math.max(0, Number(input.current_text_length) || 0) }
      : {}),
    ...(input.current_text_hash ? { current_text_hash: String(input.current_text_hash) } : {}),
    current_url: input.current_url ?? null,
    current_url_title: input.current_url_title ?? null,
    document_history_tail: Array.isArray(input.document_history_tail) ? input.document_history_tail : [],
    url_history_tail: Array.isArray(input.url_history_tail) ? input.url_history_tail : [],
    last_activity_at: String(input.last_activity_at || now),
    focused: input.focused ?? true,
    hid_active: input.hid_active ?? true,
    created_at: String(input.created_at || now),
    updated_at: String(input.updated_at || now),
  }
}

export function buildAssignmentAudit(input = {}) {
  const now = nowIso()
  return {
    id: input.id || randomId('assignment_audit'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
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
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
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
    replay_origin_wall_ms:
      input.replay_origin_wall_ms == null ? null : Number(input.replay_origin_wall_ms || 0),
    recorded_timezone_offset_minutes:
      input.recorded_timezone_offset_minutes == null ? null : Number(input.recorded_timezone_offset_minutes || 0),
    recorded_timezone: input.recorded_timezone ? String(input.recorded_timezone) : null,
    created_at: String(input.created_at || nowIso()),
    updated_at: String(input.updated_at || nowIso()),
  }
}

export function buildTeacherSessionRecord(input = {}) {
  const now = nowIso()
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
  return {
    id: input.id || randomId('teacher_session'),
    tenant_id: String(input.tenant_id || DEFAULT_TENANT_ID),
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
    tenant_id: input.tenant_id ?? null,
    teacher_id: input.teacher_id ?? null,
    teacher_name: input.teacher_name ?? null,
    teacher_email: input.teacher_email ?? null,
    provider: input.provider || 'access-code',
  }
}
